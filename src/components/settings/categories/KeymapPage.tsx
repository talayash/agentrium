import { keymapByGroup, type KeymapEntry } from '../../../lib/keymap';
import { PageHeader } from '../SettingRow';
import { registerSetting } from '../index';

registerSetting({
  category: { group: 'appearance-behavior', page: 'keymap' },
  id: 'keymap',
  label: 'Keyboard shortcuts',
  keywords: ['shortcut', 'binding', 'hotkey', 'keybinding'],
});

export default function KeymapPage() {
  const byGroup = keymapByGroup();
  const groups: KeymapEntry['group'][] = ['Terminals', 'Navigation', 'View', 'Editing', 'Git'];

  return (
    <div>
      <PageHeader
        title="Keymap"
        description="Read-only. Editing keybindings is on the roadmap."
      />

      {groups.map((g) => (
        <section key={g} className="mb-5">
          <h3 className="text-text-secondary text-[11px] font-semibold uppercase tracking-[0.06em] mb-2">{g}</h3>
          <div className="bg-elevation-1 rounded-md ring-1 ring-seam divide-y divide-[var(--seam)]">
            {byGroup[g].map((e) => (
              <div key={e.id} className="flex items-center justify-between px-3 py-1.5">
                <span className="text-text-primary text-[12.5px]">{e.label}</span>
                <kbd className="text-text-primary bg-elevation-0 ring-1 ring-border-light px-2 py-0.5 rounded text-[11px] font-mono">
                  {e.shortcut}
                </kbd>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
