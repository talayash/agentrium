import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { X, Clock, Play, Search, RotateCw } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';

interface SessionHistoryEntry {
  id: number;
  terminal_id: string;
  label: string;
  started_at: string;
  ended_at: string | null;
  log_path: string | null;
  working_directory: string | null;
  claude_session_id: string | null;
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return 'running';
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 0) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return dateStr;
  }
}

export function SessionTimeline() {
  const { closeSessionTimeline } = useAppStore();
  const { createTerminal, terminals } = useTerminalStore();
  const [sessions, setSessions] = useState<SessionHistoryEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [resuming, setResuming] = useState<number | null>(null);

  const fetchSessions = async () => {
    setLoading(true);
    try {
      const result = await invoke<SessionHistoryEntry[]>('get_session_history');
      setSessions(result);
    } catch (err) {
      reportInvokeFailure('get_session_history', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  const filtered = useMemo(() => {
    if (!filter) return sessions;
    const lower = filter.toLowerCase();
    return sessions.filter((s) => s.label.toLowerCase().includes(lower));
  }, [sessions, filter]);

  const handleResume = async (session: SessionHistoryEntry) => {
    setResuming(session.id);
    try {
      const label = `${session.label} (resumed)`;
      const colorTags = [
        'bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500',
        'bg-blue-500', 'bg-purple-500', 'bg-pink-500',
      ];
      const colorTag = colorTags[terminals.size % colorTags.length];

      // Resume in the directory the session actually ran in - not the app's cwd.
      // Fall back to '.' only for pre-migration rows that never stored a cwd.
      const cwd = session.working_directory || '.';
      if (session.claude_session_id) {
        // Exact resume of THIS conversation via --resume <id> (8th arg).
        await createTerminal(label, cwd, [], {}, colorTag, undefined, undefined, session.claude_session_id);
      } else {
        // No id captured (older row, or Claude never wrote a session file):
        // continue the most recent session in that directory (9th arg).
        await createTerminal(label, cwd, [], {}, colorTag, undefined, undefined, undefined, true);
      }
      closeSessionTimeline();
    } catch (err) {
      toast.error('Could not resume session', String(err));
      reportInvokeFailure('resume_session', err);
    } finally {
      setResuming(null);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onDoubleClick={closeSessionTimeline}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.15 }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="bg-bg-elevated ring-1 ring-white/[0.08] rounded-lg w-full max-w-2xl overflow-hidden max-h-[80vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-border">
          <div className="flex items-center gap-2">
            <Clock size={16} className="text-accent-primary" />
            <h2 className="text-text-primary text-[14px] font-semibold">Session Timeline</h2>
            <span className="text-text-tertiary text-[11px]">F7</span>
          </div>
          <button
            onClick={closeSessionTimeline}
            className="p-1 rounded hover:bg-white/[0.06] text-text-tertiary transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Filter */}
        <div className="px-4 pt-3 pb-2">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter sessions..."
              className="w-full bg-bg-primary ring-1 ring-border-light rounded-md py-1.5 pl-8 pr-3 text-[12px] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-accent-primary transition-colors"
            />
          </div>
        </div>

        {/* Timeline */}
        <div className="flex-1 overflow-y-auto px-4 pb-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RotateCw size={16} className="text-text-tertiary animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12">
              <Clock size={32} className="text-text-tertiary mx-auto mb-3" />
              <p className="text-text-secondary text-[13px]">
                {filter ? 'No sessions match your filter' : 'No session history yet'}
              </p>
            </div>
          ) : (
            <div className="relative">
              {/* Timeline line */}
              <div className="absolute left-3 top-0 bottom-0 w-px bg-border" />

              {filtered.map((session) => {
                const isRunning = !session.ended_at;
                return (
                  <div key={session.id} className="relative flex gap-4 pb-4">
                    {/* Timeline dot */}
                    <div className="relative z-10 mt-1.5 flex-shrink-0">
                      <div
                        className={`w-2.5 h-2.5 rounded-full ring-2 ring-bg-elevated ${
                          isRunning ? 'bg-success animate-pulse' : 'bg-text-tertiary'
                        }`}
                        style={{ marginLeft: '5px' }}
                      />
                    </div>

                    {/* Content */}
                    <div className="flex-1 bg-bg-primary ring-1 ring-border-light rounded-md p-3 group hover:ring-border transition-colors">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-text-primary text-[12px] font-medium truncate">
                              {session.label}
                            </span>
                            {isRunning && (
                              <span className="text-[10px] text-success bg-success/10 px-1.5 py-0.5 rounded-full font-medium">
                                running
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1">
                            <span className="text-text-tertiary text-[11px]">
                              {formatTime(session.started_at)}
                            </span>
                            <span className="text-text-tertiary text-[11px]">
                              {formatDuration(session.started_at, session.ended_at)}
                            </span>
                          </div>
                        </div>

                        {!isRunning && (
                          <button
                            onClick={() => handleResume(session)}
                            disabled={resuming === session.id}
                            className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] text-accent-primary bg-accent-primary/10 hover:bg-accent-primary/20 transition-colors opacity-0 group-hover:opacity-100 disabled:opacity-50 flex-shrink-0"
                          >
                            <Play size={10} />
                            {resuming === session.id ? 'Resuming...' : 'Resume'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}
