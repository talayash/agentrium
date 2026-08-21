import { useState, useEffect, useRef, useCallback } from 'react';
import { RotateCw, Square, ClipboardCopy, Clock, FolderOpen, Check, ClipboardPaste, Pencil } from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';
import { useAppStore } from '../store/appStore';
import { captureClaudeInput } from '../lib/terminalInput';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import { copyText, readClipboardText } from '../lib/clipboard';
import { Tooltip } from './ui/Tooltip';

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
    writeToTerminal(terminalId, '\x03').catch((err) => {
      reportInvokeFailure('write_to_terminal', err);
    });
  }, [terminalId, writeToTerminal]);

  const handleRestart = useCallback(async () => {
    if (!instance) return;
    const { label, working_directory, claude_args, env_vars, color_tag, nickname } = instance.config;
    try {
      await closeTerminal(terminalId);
      await createTerminal(label, working_directory, claude_args, env_vars, color_tag || undefined, nickname || undefined);
    } catch (err) {
      // A failure here can leave the user with no terminal at all - never silent.
      toast.error('Restart failed', 'Could not restart the terminal.');
      reportInvokeFailure('restart_terminal', err);
    }
  }, [instance, terminalId, closeTerminal, createTerminal]);

  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);

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

    const ok = await copyText(lines.join('\n'));
    if (!ok) {
      toast.error('Copy failed', 'Clipboard is unavailable');
      return;
    }
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
  }, [instance?.xterm]);

  if (!instance) return null;

  const { status, working_directory } = instance.config;
  const model = instance.model;
  const effort = instance.effort;
  const isRunning = status === 'Running';

  return (
    <div className="flex items-center justify-between h-9 px-3.5 bg-bg-secondary border-t border-border text-[12px] select-none flex-shrink-0">
      {/* Left: Duration + Model + Effort */}
      <div className="flex items-center gap-3.5 min-w-0">
        <span className="flex items-center gap-1.5 text-text-tertiary flex-shrink-0">
          <Clock size={13} />
          {elapsed}
        </span>

        {model && (
          <span className={`px-1.5 py-0.5 rounded font-medium flex-shrink-0 text-[11px] ${
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

        <Tooltip label={working_directory} side="top">
          <span className="flex items-center gap-1.5 text-text-tertiary truncate">
            <FolderOpen size={13} className="flex-shrink-0" />
            <span className="truncate">{truncatePath(working_directory)}</span>
          </span>
        </Tooltip>
      </div>

      {/* Right: Quick Actions */}
      <div className="flex items-center gap-1.5 flex-shrink-0 ml-2">
        {isRunning && (
          <Tooltip label="Interrupt" shortcut="Ctrl+C" side="top">
            <button
              onClick={handleInterrupt}
              className="p-1.5 rounded-md hover:bg-white/[0.08] text-text-tertiary hover:text-yellow-400 transition-colors"
            >
              <Square size={16} strokeWidth={2} />
            </button>
          </Tooltip>
        )}

        {/* Prompt Editor - the primary action, given an accent treatment so it
            reads as a button rather than a faint glyph. */}
        <Tooltip label="Compose prompt" shortcut="Ctrl+Shift+E" side="top">
          <button
            onClick={() => {
              const text = instance?.xterm ? captureClaudeInput(instance.xterm) : '';
              useAppStore.getState().openPromptEditor(terminalId, text);
            }}
            className="p-1.5 rounded-md bg-accent-primary/15 text-accent-primary hover:bg-accent-primary/25 transition-colors"
          >
            <Pencil size={16} strokeWidth={2.25} />
          </button>
        </Tooltip>

        <Tooltip label="Paste as file" shortcut="Ctrl+Shift+V" side="top">
          <button
            onClick={async () => {
              let clipboardText = '';
              try { clipboardText = await readClipboardText(); } catch { /* clipboard may be unavailable — open drawer with empty seed */ }
              useAppStore.getState().openPasteDrawer({
                content: clipboardText,
                targetTerminalId: terminalId,
              });
            }}
            className="p-1.5 rounded-md hover:bg-white/[0.08] text-text-tertiary hover:text-accent-primary transition-colors"
          >
            <ClipboardPaste size={16} strokeWidth={2} />
          </button>
        </Tooltip>

        <Tooltip label="Copy last output" side="top">
          <button
            onClick={handleCopyOutput}
            className="p-1.5 rounded-md hover:bg-white/[0.08] text-text-tertiary hover:text-text-secondary transition-colors"
          >
            {copied ? <Check size={16} strokeWidth={2} className="text-success" /> : <ClipboardCopy size={16} strokeWidth={2} />}
          </button>
        </Tooltip>

        <Tooltip label="Restart terminal" side="top">
          <button
            onClick={handleRestart}
            className="p-1.5 rounded-md hover:bg-white/[0.08] text-text-tertiary hover:text-accent-primary transition-colors"
          >
            <RotateCw size={16} strokeWidth={2} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
