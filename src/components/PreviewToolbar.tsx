import { useEffect, useState } from 'react';
import { RotateCw, ExternalLink, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { usePreviewStore } from '../store/previewStore';
import { isUrlAllowed } from '../lib/preview/allowlist';

interface Props { terminalId: string; url: string | null; allowed: boolean }

export function PreviewToolbar({ terminalId, url, allowed }: Props) {
  const allowList = usePreviewStore((s) => s.allowList);
  const setUserOverride = usePreviewStore((s) => s.setUserOverride);
  const reload = usePreviewStore((s) => s.reload);
  const toggleGlobal = usePreviewStore((s) => s.toggleGlobal);

  const [draft, setDraft] = useState(url ?? '');
  const [invalid, setInvalid] = useState(false);

  useEffect(() => { setDraft(url ?? ''); setInvalid(false); }, [url]);

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (!isUrlAllowed(trimmed, allowList)) { setInvalid(true); return; }
    setUserOverride(terminalId, trimmed);
  };

  const openExternal = () => { if (url && allowed) void invoke('open_external_url', { url }); };

  return (
    <div className="px-2 py-1.5 border-b border-white/[0.06] flex items-center gap-1.5 shrink-0">
      <button
        type="button"
        onClick={() => reload(terminalId)}
        disabled={!url}
        className="p-1 rounded hover:bg-white/[0.05] text-text-secondary disabled:opacity-40"
        title="Reload"
      >
        <RotateCw size={14} />
      </button>
      <input
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setInvalid(false); }}
        onKeyDown={(e) => { if (e.key === 'Enter') commit(); }}
        onBlur={commit}
        spellCheck={false}
        placeholder="Waiting for dev-server URL…"
        className={`flex-1 bg-elevation-2 border rounded px-2 py-1 text-[11.5px] text-text-primary outline-none ${
          invalid ? 'border-red-500/60' : 'border-white/[0.06] focus:border-accent-primary/60'
        }`}
      />
      <button
        type="button"
        onClick={openExternal}
        disabled={!url || !allowed}
        className="p-1 rounded hover:bg-white/[0.05] text-text-secondary disabled:opacity-40"
        title="Open in browser"
      >
        <ExternalLink size={14} />
      </button>
      <button
        type="button"
        onClick={toggleGlobal}
        className="p-1 rounded hover:bg-white/[0.05] text-text-secondary"
        title="Close preview"
      >
        <X size={14} />
      </button>
    </div>
  );
}
