import { useState, useEffect, useCallback } from 'react';
import { RotateCw, Square, ClipboardCopy, Clock, FolderOpen, Check, ClipboardPaste } from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';

interface TerminalStatusBarProps {
  terminalId: string;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function truncatePath(path: string, maxSegments = 3): string {
  const sep = path.includes('/') ? '/' : '\\';
  const parts = path.split(sep).filter(Boolean);
  if (parts.length <= maxSegments) return path;
  return '...' + sep + parts.slice(-maxSegments).join(sep);
}

export function TerminalStatusBar({ terminalId }: TerminalStatusBarProps) {
  const { terminals, writeToTerminal, closeTerminal, createTerminal } = useTerminalStore();
  const instance = terminals.get(terminalId);
  const [elapsed, setElapsed] = useState('0:00');
  const [copied, setCopied] = useState(false);

  // Session duration timer
  useEffect(() => {
    if (!instance) return;
    const createdAt = new Date(instance.config.created_at).getTime();

    const update = () => setElapsed(formatDuration(Date.now() - createdAt));
    update();

    if (instance.config.status === 'Stopped') return;

    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [instance?.config.created_at, instance?.config.status]);

  const handleInterrupt = useCallback(() => {
    writeToTerminal(terminalId, '\x03');
  }, [terminalId, writeToTerminal]);

  const handleRestart = useCallback(async () => {
    if (!instance) return;
    const { label, working_directory, claude_args, env_vars, color_tag, nickname } = instance.config;
    await closeTerminal(terminalId);
    await createTerminal(label, working_directory, claude_args, env_vars, color_tag || undefined, nickname || undefined);
  }, [instance, terminalId, closeTerminal, createTerminal]);

  const handleCopyOutput = useCallback(async () => {
    if (!instance?.xterm) return;
    const buf = instance.xterm.buffer.active;
    const lines: string[] = [];
    // Read last 50 non-empty lines
    const startRow = Math.max(0, buf.length - 50);
    for (let i = startRow; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    // Trim trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    if (lines.length === 0) return;

    await navigator.clipboard.writeText(lines.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [instance?.xterm]);

  if (!instance) return null;

  const { status, working_directory } = instance.config;
  const model = instance.model;
  const effort = instance.effort;
  const isRunning = status === 'Running';

  return (
    <div className="flex items-center justify-between h-6 px-3 bg-bg-secondary border-t border-border text-[11px] select-none flex-shrink-0">
      {/* Left: Duration + Model + Effort */}
      <div className="flex items-center gap-3 min-w-0">
        <span className="flex items-center gap-1 text-text-tertiary flex-shrink-0">
          <Clock size={10} />
          {elapsed}
        </span>

        {model && (
          <span className={`px-1 rounded font-medium flex-shrink-0 text-[9px] ${
            model === 'opus' ? 'bg-purple-500/20 text-purple-400' :
            model === 'sonnet' ? 'bg-blue-500/20 text-blue-400' :
            model === 'haiku' ? 'bg-green-500/20 text-green-400' :
            'bg-white/[0.06] text-text-tertiary'
          }`}>
            {model}
          </span>
        )}

        {effort && (
          <span className="text-text-tertiary flex-shrink-0">
            {effort}
          </span>
        )}

        <span
          className="flex items-center gap-1 text-text-tertiary truncate"
          title={working_directory}
        >
          <FolderOpen size={10} className="flex-shrink-0" />
          <span className="truncate">{truncatePath(working_directory)}</span>
        </span>
      </div>

      {/* Right: Quick Actions */}
      <div className="flex items-center gap-1 flex-shrink-0 ml-2">
        {isRunning && (
          <button
            onClick={handleInterrupt}
            className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-yellow-400 transition-colors"
            title="Interrupt (Ctrl+C)"
          >
            <Square size={10} />
          </button>
        )}

        <button
          onClick={async () => {
            let clipboardText = '';
            try { clipboardText = await navigator.clipboard.readText(); } catch { /* ignore */ }
            useAppStore.getState().openPasteDrawer({
              content: clipboardText,
              targetTerminalId: terminalId,
            });
          }}
          className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-accent-primary transition-colors"
          title="Paste as file (Ctrl+Shift+V)"
        >
          <ClipboardPaste size={10} />
        </button>

        <button
          onClick={handleCopyOutput}
          className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-text-secondary transition-colors"
          title="Copy last output"
        >
          {copied ? <Check size={10} className="text-success" /> : <ClipboardCopy size={10} />}
        </button>

        <button
          onClick={handleRestart}
          className="p-0.5 rounded hover:bg-white/[0.08] text-text-tertiary hover:text-accent-primary transition-colors"
          title="Restart terminal"
        >
          <RotateCw size={10} />
        </button>
      </div>
    </div>
  );
}
