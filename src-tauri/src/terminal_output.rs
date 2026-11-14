//! Bounded PTY delivery. Credits return only after xterm has parsed a batch.
//! Events remain global so moving a terminal to another window keeps working.
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};

const WINDOW_BYTES: usize = 256 * 1024;
pub const QUEUE_CHUNKS: usize = 16;

#[derive(Clone, serde::Serialize)]
struct OutputEvent<'a> {
    id: &'a str,
    data: &'a [u8],
    sequence: u64,
}

async fn next_batch(rx: &mut mpsc::Receiver<(String, Vec<u8>)>) -> Option<Vec<u8>> {
    let (_, mut data) = rx.recv().await?;
    // Reader chunks are at most 32 KB, so a batch is strictly below 64 KB.
    let deadline = tokio::time::Instant::now() + Duration::from_millis(2);
    while data.len() < 32 * 1024 {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Ok(Some((_, next))) => data.extend_from_slice(&next),
            _ => break,
        }
    }
    Some(data)
}

struct Credits {
    next: u64,
    pending: BTreeMap<u64, (OwnedSemaphorePermit, Vec<u8>)>,
}

#[derive(serde::Serialize)]
pub struct ReplayBatch {
    pub sequence: u64,
    pub data: Vec<u8>,
}

pub struct OutputFlow {
    available: Arc<Semaphore>,
    credits: Mutex<Credits>,
}

impl OutputFlow {
    fn new() -> Self {
        Self {
            available: Arc::new(Semaphore::new(WINDOW_BYTES)),
            credits: Mutex::new(Credits {
                next: 0,
                pending: BTreeMap::new(),
            }),
        }
    }

    async fn reserve(&self, data: &[u8]) -> Option<u64> {
        let permit = self
            .available
            .clone()
            .acquire_many_owned(data.len() as u32)
            .await
            .ok()?;
        let mut credits = self.credits.lock().unwrap();
        credits.next += 1;
        let sequence = credits.next;
        credits.pending.insert(sequence, (permit, data.to_vec()));
        Some(sequence)
    }

    fn acknowledge(&self, sequence: u64) {
        let mut credits = self.credits.lock().unwrap();
        // Ignore invalid, duplicate and late acknowledgements. xterm parses
        // batches in order, so acknowledging N also commits its predecessors.
        if sequence > credits.next {
            return;
        }
        credits.pending.retain(|&key, _| key > sequence);
    }

    fn close(&self) {
        self.available.close();
        self.credits.lock().unwrap().pending.clear();
    }
}

fn flows() -> &'static Mutex<HashMap<String, Arc<OutputFlow>>> {
    static FLOWS: OnceLock<Mutex<HashMap<String, Arc<OutputFlow>>>> = OnceLock::new();
    FLOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub struct Stream {
    id: String,
    flow: Arc<OutputFlow>,
}

impl Stream {
    // Register before spawning the forwarding task, so immediate close cannot
    // race registration and leave a task waiting for a nonexistent frontend.
    pub fn new(id: &str) -> Self {
        let flow = Arc::new(OutputFlow::new());
        flows().lock().unwrap().insert(id.to_string(), flow.clone());
        Self {
            id: id.to_string(),
            flow,
        }
    }

    pub async fn forward(&self, app: &AppHandle, rx: &mut mpsc::Receiver<(String, Vec<u8>)>) {
        while let Some(data) = next_batch(rx).await {
            // A short, bounded coalescing window amortizes JSON/event overhead
            // without waiting for a full buffer before echoing a keystroke.
            let Some(sequence) = self.flow.reserve(&data).await else {
                return;
            };
            // Serialize directly; do not allocate a serde_json::Value per byte.
            if let Err(e) = app.emit(
                "terminal-output",
                OutputEvent {
                    id: &self.id,
                    data: &data,
                    sequence,
                },
            ) {
                crate::error_reporter::report_bg("emit_terminal_output", e.to_string());
                return;
            }
        }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        close(&self.id);
    }
}

pub fn acknowledge(id: &str, sequence: u64) {
    if let Some(flow) = flows().lock().unwrap().get(id) {
        flow.acknowledge(sequence);
    }
}

/// A newly opened window may have missed the global events preceding adoption.
/// Replay the bounded unacknowledged tail before it accepts newer live output.
pub fn pending(id: &str) -> Vec<ReplayBatch> {
    let registry = flows().lock().unwrap();
    let Some(flow) = registry.get(id) else {
        return Vec::new();
    };
    let credits = flow.credits.lock().unwrap();
    credits
        .pending
        .iter()
        .map(|(&sequence, (_, data))| ReplayBatch {
            sequence,
            data: data.clone(),
        })
        .collect()
}

pub fn close(id: &str) {
    if let Some(flow) = flows().lock().unwrap().remove(id) {
        flow.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn transfer_replays_only_unacknowledged_bytes() {
        let stream = Stream::new("transfer-test");
        let first = stream.flow.reserve(b"first").await.unwrap();
        let second = stream.flow.reserve(b"second").await.unwrap();
        acknowledge("transfer-test", first);
        let replay = pending("transfer-test");
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].sequence, second);
        assert_eq!(replay[0].data, b"second");
        drop(stream);
        assert!(pending("transfer-test").is_empty());
    }

    #[tokio::test]
    async fn batching_preserves_bytes_and_flushes_the_final_partial_batch() {
        let (tx, mut rx) = mpsc::channel(8);
        let chunks = [
            vec![27, 91],
            vec![51, 49, 109],
            vec![65; 32 * 1024],
            vec![66; 7],
        ];
        for chunk in &chunks {
            tx.send(("t".into(), chunk.clone())).await.unwrap();
        }
        drop(tx);
        let mut output = Vec::new();
        let mut batches = 0;
        while let Some(batch) = next_batch(&mut rx).await {
            assert!(batch.len() < 64 * 1024);
            output.extend(batch);
            batches += 1;
        }
        assert_eq!(output, chunks.concat());
        assert_eq!(batches, 2);
    }

    #[tokio::test]
    async fn pauses_until_parsed_and_duplicate_ack_cannot_inflate_window() {
        let flow = OutputFlow::new();
        let sequence = flow.reserve(&vec![0; WINDOW_BYTES]).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(10), flow.reserve(&[0]))
                .await
                .is_err()
        );
        flow.acknowledge(sequence + 1); // not sent
        assert_eq!(flow.available.available_permits(), 0);
        flow.acknowledge(sequence);
        flow.acknowledge(sequence);
        assert_eq!(flow.available.available_permits(), WINDOW_BYTES);
        assert!(flow.reserve(&vec![0; WINDOW_BYTES]).await.is_some());
    }

    #[tokio::test]
    async fn close_unblocks_a_paused_stream() {
        let flow = Arc::new(OutputFlow::new());
        flow.reserve(&vec![0; WINDOW_BYTES]).await.unwrap();
        let waiter = {
            let flow = flow.clone();
            tokio::spawn(async move { flow.reserve(&[0]).await })
        };
        flow.close();
        assert_eq!(waiter.await.unwrap(), None);
    }
}
