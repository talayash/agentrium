import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Send, Square, TerminalSquare } from 'lucide-react';
import { interruptAgent, sendPrompt } from '../../lib/promptSend';
import { registerPromptBar } from '../../lib/terminalFocus';
import { useTerminalStore } from '../../store/terminalStore';
import { reportInvokeFailure } from '../../lib/errorReporter';
import { useInsightStore } from '../../store/insightStore';
import { toast } from '../../store/toastStore';

const MAX_HEIGHT_PX = 8 * 20;
const FOCUS_RING = 'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-accent-primary/45';

interface Props {
  terminalId: string;
  disabledReason: string | null;
  busy: boolean;
  onShowTerminal: () => void;
  /** The hidden terminal needs the user: make the Terminal button prominent. */
  terminalNeedsYou?: boolean;
}

/** Imperative handle so the insight-only view can move focus to the bar. */
export interface PromptBarHandle {
  focus: () => void;
  /** When the user last pressed a key in the bar (ms epoch, 0 = never). */
  lastKeyAt: () => number;
}

export const PromptBar = forwardRef<PromptBarHandle, Props>(function PromptBar(
  { terminalId, disabledReason, busy, onShowTerminal, terminalNeedsYou = false },
  handle,
) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // A focus request while disabled (e.g. right after answering a question,
  // before the question clears) is honoured once the bar is enabled again.
  const wantFocus = useRef(false);
  const focusBar = () => {
    if (ref.current && !ref.current.disabled) {
      wantFocus.current = false;
      ref.current.focus();
    } else {
      wantFocus.current = true;
    }
  };
  const lastKeyAtRef = useRef(0);
  useImperativeHandle(handle, () => ({ focus: focusBar, lastKeyAt: () => lastKeyAtRef.current }), []);
  const sending = useRef(false);
  // null = not walking history; otherwise index into the history list.
  const histIdx = useRef<number | null>(null);
  const draft = useRef('');
  const disabled = disabledReason !== null;

  useEffect(() => registerPromptBar(terminalId, {
    focus: focusBar,
    insertText: (insert) => {
      setText((cur) => (cur === '' || /\s$/.test(cur) ? cur + insert : `${cur} ${insert}`));
      histIdx.current = null;
      focusBar();
    },
  }), [terminalId]);

  useEffect(() => {
    if (disabled || !wantFocus.current) return;
    wantFocus.current = false;
    // Only take focus back if nothing else claimed it meanwhile and this is
    // still the active terminal. Focus parked on the insight view while the
    // bar was disabled counts as unclaimed.
    const active = document.activeElement;
    const idle = !active || active === document.body || active.hasAttribute('data-focus-parking');
    if (idle && useTerminalStore.getState().activeTerminalId === terminalId) ref.current?.focus();
  }, [disabled, terminalId]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [text]);

  const fail = (err: unknown) => {
    toast.error('Could not send to the terminal');
    reportInvokeFailure('write_to_terminal', err);
  };

  const send = async () => {
    if (disabled || sending.current || text.trim() === '') return;
    const sent = text;
    sending.current = true;
    useInsightStore.getState().pushPromptHistory(terminalId, sent.trimEnd());
    histIdx.current = null;
    draft.current = '';
    setText('');
    try {
      await sendPrompt(terminalId, sent);
    } catch (err) {
      setText(sent);
      fail(err);
    } finally {
      sending.current = false;
    }
  };

  const stop = () => {
    interruptAgent(terminalId).catch(fail);
  };

  const walk = (dir: -1 | 1): boolean => {
    const hist = useInsightStore.getState().promptHistory(terminalId);
    const cur = histIdx.current;
    if (dir === -1) {
      if (hist.length === 0) return false;
      if (cur === null) draft.current = text;
      const next = cur === null ? hist.length - 1 : Math.max(0, cur - 1);
      histIdx.current = next;
      setText(hist[next]!);
      return true;
    }
    if (cur === null) return false;
    if (cur >= hist.length - 1) {
      histIdx.current = null;
      setText(draft.current);
    } else {
      histIdx.current = cur + 1;
      setText(hist[cur + 1]!);
    }
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    lastKeyAtRef.current = Date.now();
    if (e.key === 'Escape') {
      // Esc that cancels an IME composition must not interrupt the agent.
      if (busy && !e.nativeEvent.isComposing) {
        e.stopPropagation();
        e.preventDefault();
        stop();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
      return;
    }
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const { selectionStart, selectionEnd, value } = e.currentTarget;
      if (selectionStart !== selectionEnd) return;
      if (e.key === 'ArrowUp') {
        const onFirstLine = value === '' || !value.slice(0, selectionStart).includes('\n');
        if (onFirstLine && walk(-1)) e.preventDefault();
      } else {
        const onLastLine = !value.slice(selectionEnd).includes('\n');
        if (onLastLine && walk(1)) e.preventDefault();
      }
    }
  };

  return (
    <div className="flex items-end gap-2 border-t border-seam bg-elevation-1 px-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          disabled={disabled}
          placeholder="Message the agent"
          aria-label="Message the agent"
          data-terminal-input=""
          onChange={(e) => { setText(e.target.value); histIdx.current = null; }}
          onKeyDown={onKeyDown}
          className={`w-full resize-none rounded-md border border-seam bg-elevation-2 px-3 py-2 text-[13px] leading-5 text-text-primary placeholder:text-text-tertiary disabled:opacity-60 ${FOCUS_RING}`}
        />
        {disabledReason && <span className="text-[11px] text-text-tertiary">{disabledReason}</span>}
      </div>
      {busy && (
        <button
          type="button"
          onClick={stop}
          aria-label="Stop"
          title="Stop (Esc)"
          className={`flex h-9 items-center gap-1 rounded-md border border-seam px-2.5 text-[12px] text-text-secondary hover:bg-elevation-2 ${FOCUS_RING}`}
        >
          <Square size={12} aria-hidden /> Stop
        </button>
      )}
      <button
        type="button"
        onClick={() => void send()}
        disabled={disabled}
        aria-label="Send"
        title="Send (Enter)"
        className={`flex h-9 items-center gap-1 rounded-md bg-accent-primary px-2.5 text-[12px] text-white disabled:opacity-50 ${FOCUS_RING}`}
      >
        <Send size={12} aria-hidden /> Send
      </button>
      <button
        type="button"
        onClick={onShowTerminal}
        aria-label="Show terminal"
        title="Show terminal"
        data-attention={terminalNeedsYou || undefined}
        className={`flex h-9 items-center gap-1 rounded-md px-2.5 text-[12px] ${
          terminalNeedsYou
            ? 'bg-accent-primary text-white'
            : 'border border-seam text-text-secondary hover:bg-elevation-2'
        } ${FOCUS_RING}`}
      >
        <TerminalSquare size={12} aria-hidden /> Terminal
      </button>
    </div>
  );
});
