import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useTerminalStore } from '../store/terminalStore';
import { usePreviewStore } from '../store/previewStore';

const AUTO_DISMISS_MS = 6000;

export function PreviewInlineHint() {
  const activeId = useTerminalStore((s) => s.activeTerminalId);
  const globalOpen = usePreviewStore((s) => s.globalOpen);
  const perTerminal = usePreviewStore((s) => s.perTerminal);
  const dismissInlineHint = usePreviewStore((s) => s.dismissInlineHint);
  const toggleGlobal = usePreviewStore((s) => s.toggleGlobal);

  const state = activeId ? perTerminal.get(activeId) : undefined;
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!state || globalOpen) { setVisible(false); return; }
    if (state.inlineHintDismissed) { setVisible(false); return; }
    if (!state.detectedUrl) { setVisible(false); return; }
    setVisible(true);
    const t = setTimeout(() => { if (activeId) dismissInlineHint(activeId); }, AUTO_DISMISS_MS);
    return () => clearTimeout(t);
  }, [state?.detectedUrl, state?.inlineHintDismissed, globalOpen, activeId, dismissInlineHint, state]);

  const url = state?.detectedUrl;
  return (
    <AnimatePresence>
      {visible && activeId && url && (
        <motion.div
          initial={{ y: 24, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 24, opacity: 0 }}
          className="fixed bottom-8 right-6 z-50 bg-elevation-3 ring-1 ring-seam-strong rounded-md shadow-lg px-3 py-2 flex items-center gap-2"
        >
          <span className="text-text-secondary text-[12px]">
            Detected <code className="text-text-primary">{url}</code>
          </span>
          <button
            onClick={() => { toggleGlobal(); dismissInlineHint(activeId); }}
            className="text-[12px] font-medium text-accent-primary hover:text-accent-secondary"
          >
            Open preview
          </button>
          <button
            onClick={() => dismissInlineHint(activeId)}
            className="text-[12px] text-text-tertiary hover:text-text-secondary"
          >
            Dismiss
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
