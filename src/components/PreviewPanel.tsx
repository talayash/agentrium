import { useMemo } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { usePreviewStore } from '../store/previewStore';
import { isUrlAllowed } from '../lib/preview/allowlist';
import { PreviewToolbar } from './PreviewToolbar';

export function PreviewPanel() {
  const activeId = useTerminalStore((s) => s.activeTerminalId);
  const globalOpen = usePreviewStore((s) => s.globalOpen);
  const panelWidthPx = usePreviewStore((s) => s.panelWidthPx);
  const allowList = usePreviewStore((s) => s.allowList);
  const perTerminal = usePreviewStore((s) => s.perTerminal);
  const resolveUrl = usePreviewStore((s) => s.resolveUrl);
  const keepAliveAcrossTabs = usePreviewStore((s) => s.keepAliveAcrossTabs);

  const url = activeId ? resolveUrl(activeId) : null;
  const state = activeId ? perTerminal.get(activeId) : undefined;
  const reloadCounter = state?.reloadCounter ?? 0;

  const allowed = useMemo(
    () => (url ? isUrlAllowed(url, allowList) : false),
    [url, allowList],
  );

  // When keep-alive is on, render an iframe per terminal with a resolved URL;
  // only the active tab's iframe is visible, the rest are hidden but stay
  // mounted so their preview state (scroll, form fields, etc.) survives a tab
  // switch. Filter to allowed URLs only — blocked URLs get the same placeholder
  // as the single-iframe path.
  const keepAliveEntries = useMemo(() => {
    if (!keepAliveAcrossTabs) return [] as Array<{ id: string; url: string; reloadCounter: number }>;
    const out: Array<{ id: string; url: string; reloadCounter: number }> = [];
    for (const [id, s] of perTerminal) {
      const u = s.userOverride ?? s.detectedUrl;
      if (u && isUrlAllowed(u, allowList)) {
        out.push({ id, url: u, reloadCounter: s.reloadCounter });
      }
    }
    return out;
  }, [keepAliveAcrossTabs, perTerminal, allowList]);

  if (!globalOpen || !activeId) return null;

  return (
    <div
      className="h-full flex flex-col bg-bg-secondary border-l border-white/[0.06] overflow-hidden"
      style={{ width: panelWidthPx }}
      data-testid="preview-panel"
    >
      <PreviewToolbar terminalId={activeId} url={url} allowed={allowed} />

      <div className="flex-1 relative bg-black">
        {!url && (
          <div className="absolute inset-0 flex items-center justify-center text-text-tertiary text-[12px]">
            Waiting for a dev-server URL…
          </div>
        )}
        {url && !allowed && (
          <div className="absolute inset-0 flex items-center justify-center text-center p-6">
            <div className="max-w-sm">
              <div className="text-text-primary text-[13px] font-semibold mb-1">
                URL not allowed
              </div>
              <div className="text-text-tertiary text-[11.5px]">
                <code className="text-text-secondary">{url}</code> is outside the preview allow-list.
                Add it in Settings → Preview.
              </div>
            </div>
          </div>
        )}
        {url && allowed && !keepAliveAcrossTabs && (
          <iframe
            key={`${url}#${reloadCounter}`}
            src={url}
            title="Preview"
            className="absolute inset-0 w-full h-full border-0"
          />
        )}
        {url && allowed && keepAliveAcrossTabs && keepAliveEntries.map(({ id, url: entryUrl, reloadCounter: rc }) => {
          const isActive = id === activeId;
          return (
            <iframe
              key={`${id}:${entryUrl}#${rc}`}
              src={entryUrl}
              title={`Preview (${id})`}
              className="absolute inset-0 w-full h-full border-0"
              style={{
                visibility: isActive ? 'visible' : 'hidden',
                pointerEvents: isActive ? 'auto' : 'none',
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
