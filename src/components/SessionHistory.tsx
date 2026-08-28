import { useState, useEffect, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, Trash2, Clock, FileText } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { ListRow } from './ui/ListRow';
import { EmptyState } from './ui/EmptyState';
import { LatestRequest } from '../lib/latestRequest';

interface SessionHistoryEntry {
  id: number;
  terminal_id: string;
  label: string;
  started_at: string;
  ended_at: string | null;
  log_path: string | null;
}

export function SessionHistory() {
  const { closeSessionHistory } = useAppStore();
  const [entries, setEntries] = useState<SessionHistoryEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<SessionHistoryEntry | null>(null);
  const [logContent, setLogContent] = useState<string>('');
  const [loadingLog, setLoadingLog] = useState(false);
  const logRequestRef = useRef(new LatestRequest());

  useEffect(() => {
    loadHistory();
  }, []);

  const loadHistory = async () => {
    try {
      const history = await invoke<SessionHistoryEntry[]>('get_session_history');
      setEntries(history);
    } catch (err) {
      reportInvokeFailure('get_session_history', err);
    }
  };

  const handleSelect = async (entry: SessionHistoryEntry) => {
    const requestId = logRequestRef.current.begin();
    setSelectedEntry(entry);
    setLogContent('');
    setLoadingLog(Boolean(entry.log_path));
    if (!entry.log_path) return;
    try {
      const content = await invoke<string>('read_log_file', { path: entry.log_path });
      if (logRequestRef.current.isCurrent(requestId)) setLogContent(content);
    } catch (err) {
      if (logRequestRef.current.isCurrent(requestId)) setLogContent(`Failed to load log: ${err}`);
      reportInvokeFailure('read_log_file', err);
    } finally {
      if (logRequestRef.current.isCurrent(requestId)) setLoadingLog(false);
    }
  };

  const handleDelete = async (entry: SessionHistoryEntry) => {
    try {
      await invoke('delete_session_history', { id: entry.id, logPath: entry.log_path });
      if (selectedEntry?.id === entry.id) {
        logRequestRef.current.invalidate();
        setSelectedEntry(null);
        setLogContent('');
        setLoadingLog(false);
      }
      await loadHistory();
    } catch (err) {
      reportInvokeFailure('delete_session_history', err);
    }
  };

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  };

  const formatDuration = (start: string, end: string | null) => {
    if (!end) return 'running';
    try {
      const ms = new Date(end).getTime() - new Date(start).getTime();
      const secs = Math.floor(ms / 1000);
      if (secs < 60) return `${secs}s`;
      const mins = Math.floor(secs / 60);
      if (mins < 60) return `${mins}m ${secs % 60}s`;
      const hours = Math.floor(mins / 60);
      return `${hours}h ${mins % 60}m`;
    } catch {
      return '';
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onDoubleClick={closeSessionHistory}
    >
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.15 }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="bg-bg-elevated ring-1 ring-white/[0.08] rounded-lg w-full max-w-4xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-text-secondary" />
            <h2 className="text-text-primary text-[14px] font-semibold">Session History</h2>
          </div>
          <button
            onClick={closeSessionHistory}
            className="p-1 rounded hover:bg-white/[0.06] text-text-tertiary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="flex h-[500px]">
          {/* Left: Entry List */}
          <div className="w-72 border-r border-border overflow-y-auto p-2">
            {entries.map((entry) => (
              <ListRow
                key={entry.id}
                selected={selectedEntry?.id === entry.id}
                onClick={() => handleSelect(entry)}
                className="group items-start py-1.5 mb-0.5"
                trailing={
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(entry);
                    }}
                    className="p-1 rounded hover:bg-red-500/10 text-text-tertiary hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                  >
                    <Trash2 size={12} />
                  </button>
                }
              >
                <div className="min-w-0 flex-1">
                  <p className="text-text-primary text-[12px] font-medium truncate">{entry.label}</p>
                  <p className="text-text-tertiary text-[11px] mt-0.5">
                    {formatDate(entry.started_at)}
                  </p>
                  <p className="text-text-tertiary text-[11px]">
                    Duration: {formatDuration(entry.started_at, entry.ended_at)}
                  </p>
                </div>
              </ListRow>
            ))}

            {entries.length === 0 && (
              <EmptyState
                icon={<Clock size={20} strokeWidth={1.75} />}
                title="No session history yet"
                description="Closed terminals with saved logs will appear here."
                compact
              />
            )}
          </div>

          {/* Right: Log Preview */}
          <div className="flex-1 flex flex-col">
            {selectedEntry ? (
              <>
                <div className="p-3 border-b border-border">
                  <div className="flex items-center gap-2">
                    <FileText size={14} className="text-text-secondary" />
                    <span className="text-text-primary text-[13px] font-medium">{selectedEntry.label}</span>
                  </div>
                  <p className="text-text-tertiary text-[11px] mt-1">
                    {formatDate(selectedEntry.started_at)}
                    {selectedEntry.ended_at && ` - ${formatDate(selectedEntry.ended_at)}`}
                  </p>
                </div>
                <div className="flex-1 overflow-auto p-3">
                  {loadingLog ? (
                    <p className="text-text-tertiary text-[12px]">Loading log...</p>
                  ) : selectedEntry.log_path ? (
                    <pre className="text-text-secondary text-[11px] font-mono whitespace-pre-wrap break-words leading-relaxed">
                      {logContent}
                    </pre>
                  ) : (
                    <p className="text-text-tertiary text-[12px]">No log file available</p>
                  )}
                </div>
              </>
            ) : (
              <div className="h-full flex items-center justify-center text-text-tertiary text-[13px]">
                Select a session to view its log
              </div>
            )}
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}
