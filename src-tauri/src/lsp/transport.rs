//! LSP base-protocol framing: `Content-Length: N\r\n...\r\n\r\n<N bytes>`.

/// Incremental decoder. Feed raw stdout bytes, get back complete message
/// bodies. Holds partial data between feeds.
pub struct FrameDecoder {
    buf: Vec<u8>,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<Vec<u8>> {
        self.buf.extend_from_slice(data);
        let mut out = Vec::new();
        loop {
            let Some(header_end) = find_subslice(&self.buf, b"\r\n\r\n") else {
                break;
            };
            let header = String::from_utf8_lossy(&self.buf[..header_end]).to_string();
            let len = header.lines().find_map(|l| {
                let (k, v) = l.split_once(':')?;
                if k.trim().eq_ignore_ascii_case("content-length") {
                    v.trim().parse::<usize>().ok()
                } else {
                    None
                }
            });
            let Some(len) = len else {
                // Malformed header block: drop it so we can't loop forever.
                self.buf.drain(..header_end + 4);
                continue;
            };
            let body_start = header_end + 4;
            if self.buf.len() < body_start + len {
                break; // body not fully arrived yet
            }
            out.push(self.buf[body_start..body_start + len].to_vec());
            self.buf.drain(..body_start + len);
        }
        out
    }
}

pub fn encode_frame(body: &[u8]) -> Vec<u8> {
    let mut out = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    out.extend_from_slice(body);
    out
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(body: &str) -> Vec<u8> {
        format!("Content-Length: {}\r\n\r\n{}", body.len(), body).into_bytes()
    }

    #[test]
    fn decodes_single_complete_frame() {
        let mut d = FrameDecoder::new();
        let out = d.feed(&frame(r#"{"a":1}"#));
        assert_eq!(out, vec![br#"{"a":1}"#.to_vec()]);
    }

    #[test]
    fn decodes_frame_split_across_feeds() {
        let mut d = FrameDecoder::new();
        let bytes = frame(r#"{"a":1}"#);
        let (first, second) = bytes.split_at(10);
        assert!(d.feed(first).is_empty());
        assert_eq!(d.feed(second), vec![br#"{"a":1}"#.to_vec()]);
    }

    #[test]
    fn decodes_two_frames_in_one_feed() {
        let mut d = FrameDecoder::new();
        let mut bytes = frame(r#"{"a":1}"#);
        bytes.extend(frame(r#"{"b":2}"#));
        let out = d.feed(&bytes);
        assert_eq!(out.len(), 2);
        assert_eq!(out[1], br#"{"b":2}"#.to_vec());
    }

    #[test]
    fn handles_extra_headers_case_insensitively() {
        let body = r#"{"a":1}"#;
        let raw = format!(
            "content-length: {}\r\nContent-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n{}",
            body.len(), body
        );
        let mut d = FrameDecoder::new();
        assert_eq!(d.feed(raw.as_bytes()), vec![body.as_bytes().to_vec()]);
    }

    #[test]
    fn drops_malformed_header_without_looping() {
        let mut d = FrameDecoder::new();
        let mut bytes = b"Garbage: x\r\n\r\n".to_vec();
        bytes.extend(frame(r#"{"ok":true}"#));
        assert_eq!(d.feed(&bytes), vec![br#"{"ok":true}"#.to_vec()]);
    }

    #[test]
    fn encode_frame_roundtrips() {
        let body = br#"{"jsonrpc":"2.0"}"#;
        let mut d = FrameDecoder::new();
        assert_eq!(d.feed(&encode_frame(body)), vec![body.to_vec()]);
    }
}
