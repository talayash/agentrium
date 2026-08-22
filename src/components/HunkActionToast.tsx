import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Undo2 } from 'lucide-react';
import { useHunkUndoStore } from '../store/hunkUndoStore';

const UNDO_TIMEOUT_MS = 5000;

export function HunkActionToast() {
  const stack = useHunkUndoStore((s) => s.stack);
  const undoAll = useHunkUndoStore((s) => s.undoAll);
  const [remaining, setRemaining] = useState(0);
  const [summary, setSummary] = useState<string | null>(null);

  useEffect(() => {
    if (stack.length === 0) {
      setRemaining(0);
      return;
    }
    const start = Date.now();
    setRemaining(UNDO_TIMEOUT_MS);
    const id = setInterval(() => {
      const elapsed = Date.now() - start;
      setRemaining(Math.max(0, UNDO_TIMEOUT_MS - elapsed));
    }, 100);
    return () => clearInterval(id);
  }, [stack.length]);

  useEffect(() => {
    if (summary) {
      const id = setTimeout(() => setSummary(null), 3000);
      return () => clearTimeout(id);
    }
  }, [summary]);

  const label = (() => {
    if (stack.length === 0) return '';
    if (stack.length === 1) {
      const a = stack[0];
      const verb = a.kind === 'stage' ? 'Staged' : 'Discarded';
      return `${verb} hunk @L${a.atLine}`;
    }
    const allStage = stack.every((a) => a.kind === 'stage');
    const allDiscard = stack.every((a) => a.kind === 'discard');
    if (allStage) return `Staged ${stack.length} hunks`;
    if (allDiscard) return `Discarded ${stack.length} hunks`;
    return `Actioned ${stack.length} hunks`;
  })();

  const handleUndo = async () => {
    const result = await undoAll();
    if (result.failed > 0) {
      setSummary(
        `Undone ${result.ok} of ${result.ok + result.failed}. ${result.failed} hunks changed since (context mismatch).`
      );
    }
  };

  const secs = Math.ceil(remaining / 1000);

  return (
    <AnimatePresence>
      {stack.length > 0 && !summary && (
        <motion.div
          key="toast"
          role="status"
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 24, opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="sticky bottom-0 mx-2 mb-2 rounded-md bg-[var(--elevation-3)] ring-1 ring-[var(--border)] shadow-lg overflow-hidden"
        >
          <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
            <span className="text-text-primary flex-1">{label}</span>
            <button
              onClick={handleUndo}
              className="flex items-center gap-1 text-accent-primary hover:text-accent-secondary text-[12px] font-medium"
            >
              <Undo2 size={12} /> Undo {stack.length > 1 ? 'all' : ''} ({secs}s)
            </button>
          </div>
          <div
            className="h-[2px] bg-accent-primary origin-left"
            style={{ transform: `scaleX(${remaining / UNDO_TIMEOUT_MS})` }}
          />
        </motion.div>
      )}
      {summary && (
        <motion.div
          key="summary"
          role="status"
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 24, opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="sticky bottom-0 mx-2 mb-2 rounded-md bg-[var(--elevation-3)] ring-1 ring-yellow-400/40 shadow-lg px-3 py-2 text-[12px] text-text-primary"
        >
          {summary}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
