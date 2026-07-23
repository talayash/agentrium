import { useMemo } from 'react';
import { useTerminalStore } from '../store/terminalStore';
import { usePreviewStore } from '../store/previewStore';
import { isUrlAllowed } from '../lib/preview/allowlist';

export function PreviewPanel() {
  const activeId = useTerminalStore((s) => s.activeTerminalId);
  const globalOpen = usePreviewStore((s) => s.globalOpen);
  const panelWidthPx = usePreviewStore((s) => s.panelWidthPx);
  const allowList = usePreviewStore((s) => s.allowList);
  const perTerminal = usePreviewStore((s) => s.perTerminal);
  const resolveUrl = usePreviewStore((s) => s.resolveUrl);

  const url = activeId ? resolveUrl(activeId) : null;
  const state = activeId ? perTerminal.get(activeId) : undefined;
  const reloadCounter = state?.reloadCounter ?? 0;

  const allowed = useMemo(
    () => (url ? isUrlAllowed(url, allowList) : false),
    [url, allowList],
  );

  if (!globalOpen || !activeId) return null;

  return (
    <div
      className="h-full flex flex-col bg-bg-secondary border-l border-white/[0.06] overflow-hidden"
      style={{ width: panelWidthPx }}
      data-testid="preview-panel"
    >
      <div className="px-3 py-2 border-b border-white/[0.06] flex items-center justify-between shrink-0">
        <div className="text-text-primary text-[12px] font-medium">Preview</div>
        <div className="text-text-tertiary text-[11px] truncate max-w-[65%]">
          {url ?? 'no url'}
        </div>
      </div>

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
        {url && allowed && (
          <iframe
            key={`${url}#${reloadCounter}`}
            src={url}
            title="Preview"
            className="absolute inset-0 w-full h-full border-0"
          />
        )}
      </div>
    </div>
  );
}
