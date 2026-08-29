import { useState } from 'react';
import { Trash2, Plus } from 'lucide-react';
import { usePreviewStore } from '../../../store/previewStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'tools', page: 'preview' } as const;
registerSetting({
  category: cat,
  id: 'allowlist',
  label: 'Preview allow-list',
  keywords: ['preview', 'iframe', 'allow', 'domain', 'ngrok', 'tunnel'],
});
registerSetting({
  category: cat,
  id: 'keep-alive',
  label: 'Keep preview alive across tabs',
  keywords: ['preview', 'iframe', 'keep alive', 'tabs'],
});

export default function PreviewPage() {
  const allowList = usePreviewStore((s) => s.allowList);
  const keepAliveAcrossTabs = usePreviewStore((s) => s.keepAliveAcrossTabs);
  const addToAllowList = usePreviewStore((s) => s.addToAllowList);
  const removeFromAllowList = usePreviewStore((s) => s.removeFromAllowList);
  const setKeepAliveAcrossTabs = usePreviewStore((s) => s.setKeepAliveAcrossTabs);

  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleAdd = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setError('Enter a pattern like *.ngrok.io');
      return;
    }
    // Only *.hostname.tld is supported by the allow-list matcher (single
    // leading wildcard label). Reject obvious non-conforming shapes so users
    // don't wonder why their pattern doesn't match at runtime.
    if (!/^\*\.[^*\s]+$/.test(trimmed) && /[*]/.test(trimmed)) {
      setError('Only patterns like *.hostname.tld are supported.');
      return;
    }
    addToAllowList(trimmed);
    setDraft('');
    setError(null);
  };

  return (
    <div>
      <PageHeader
        title="Preview"
        description="Right-docked live preview for dev servers. Localhost is always allowed; add tunnel domains here."
      />

      <PageSection
        title="Allow-list"
        description="Only URLs on localhost or matching one of these host patterns will load in the preview iframe. Use *.hostname.tld to allow one wildcard label (e.g. *.ngrok.io matches abc.ngrok.io)."
      >
        <div className="py-2 space-y-1.5">
          {allowList.length === 0 && (
            <p className="text-text-tertiary text-[12px] py-1">
              No custom entries. Localhost (127.0.0.1, 0.0.0.0, localhost) is always allowed.
            </p>
          )}
          {allowList.map((pattern) => (
            <div
              key={pattern}
              className="flex items-center justify-between gap-2 bg-elevation-0 ring-1 ring-[var(--ij-divider-soft)] rounded-md px-2 h-8"
            >
              <code className="text-text-primary text-[12px] font-mono truncate">{pattern}</code>
              <button
                onClick={() => removeFromAllowList(pattern)}
                className="p-1 rounded hover:bg-red-500/10 text-text-tertiary hover:text-red-400 transition-colors flex-shrink-0"
                title="Remove"
                aria-label={`Remove ${pattern}`}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1.5 py-2 border-t border-[var(--ij-divider-soft)]">
          <input
            type="text"
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setError(null); }}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); }}
            placeholder="*.ngrok.io"
            spellCheck={false}
            className="flex-1 bg-elevation-0 text-text-primary text-[12px] font-mono px-2 h-8 rounded ring-1 ring-border-light focus:outline-none focus:ring-[3px] focus:ring-accent-primary/45 transition-colors"
          />
          <button
            onClick={handleAdd}
            className="flex items-center gap-1 px-2.5 h-8 bg-accent-primary hover:bg-accent-secondary text-white rounded text-[12px] transition-colors"
          >
            <Plus size={13} />
            Add
          </button>
        </div>
        {error && <p className="text-red-400 text-[11.5px] pb-2">{error}</p>}
      </PageSection>

      <PageSection title="Behavior">
        <SettingRow
          label="Keep preview alive across tab switches"
          description="Render an iframe for every terminal with a resolved URL and just hide the inactive ones. Uses more memory but avoids reloading state when you switch tabs."
        >
          <Toggle value={keepAliveAcrossTabs} onChange={setKeepAliveAcrossTabs} />
        </SettingRow>
      </PageSection>
    </div>
  );
}
