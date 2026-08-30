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
    const { label, working_directory, claude_args, env_vars, color_tag, nickname, agent } = instance.config;
    try {
      await closeTerminal(terminalId);
      await createTerminal(label, working_directory, claude_args, env_vars, color_tag || undefined, nickname || undefined, undefined, undefined, undefined, undefined, agent);
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
    <div className="flex items-center justify-between h-8 px-3 border-t border-seam text-[11.5px] select-none flex-shrink-0">
      {/* Left: session vitals - duration · model · effort · folder */}
      <div className="flex items-center gap-3 min-w-0">
        <Tooltip label="Session duration" side="top">
          <span className="flex items-center gap-1.5 text-text-tertiary tabular-nums flex-shrink-0">
            <Clock size={12} strokeWidth={1.75} />
            {elapsed}
          </span>
        </Tooltip>

        {model && (
          <span className={`px-1.5 h-[17px] flex items-center rounded-md font-medium flex-shrink-0 text-[10.5px] ${
            model === 'opus' ? 'bg-purple-500/20 text-purple-400' :
            model === 'sonnet' ? 'bg-blue-500/20 text-blue-400' :
            model === 'haiku' ? 'bg-green-500/20 text-green-400' :
            'bg-fill-hover text-text-tertiary'
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
            <FolderOpen size={12} className="flex-shrink-0" strokeWidth={1.75} />
            <span className="truncate text-[11px]" dir="ltr">{truncatePath(working_directory)}</span>
          </span>
        </Tooltip>
      </div>

      {/* Right: quick actions - one visual family, accent reserved for the
          primary Compose action. */}
      <div className="flex items-center gap-1 flex-shrink-0 ml-2">
        {isRunning && (
          <Tooltip label="Interrupt" shortcut="Ctrl+C" side="top">
            <button
              onClick={handleInterrupt}
              className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-fill-active text-text-tertiary hover:text-warning transition-colors"
            >
              <Square size={14} strokeWidth={2} />
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
            className="w-7 h-7 flex items-center justify-center rounded-md bg-accent-primary/15 text-accent-primary hover:bg-accent-primary/25 transition-colors"
          >
            <Pencil size={14} strokeWidth={2.25} />
          </button>
        </Tooltip>

        <Tooltip label="Paste as file" shortcut="Ctrl+Shift+V" side="top">
          <button
            onClick={async () => {
              let clipboardText = '';
              try { clipboardText = await readClipboardText(); } catch { /* clipboard may be unavailable - open drawer with empty seed */ }
              useAppStore.getState().openPasteDrawer({
                content: clipboardText,
                targetTerminalId: terminalId,
              });
            }}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-fill-active text-text-tertiary hover:text-text-primary transition-colors"
          >
            <ClipboardPaste size={14} strokeWidth={2} />
          </button>
        </Tooltip>

        <Tooltip label="Copy last output" side="top">
          <button
            onClick={handleCopyOutput}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-fill-active text-text-tertiary hover:text-text-primary transition-colors"
          >
            {copied ? <Check size={14} strokeWidth={2} className="text-success" /> : <ClipboardCopy size={14} strokeWidth={2} />}
          </button>
        </Tooltip>

        <Tooltip label="Restart terminal" side="top">
          <button
            onClick={handleRestart}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-fill-active text-text-tertiary hover:text-text-primary transition-colors"
          >
            <RotateCw size={14} strokeWidth={2} />
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
