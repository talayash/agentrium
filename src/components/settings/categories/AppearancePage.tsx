import { useAppStore, DEFAULT_ACCENT_COLOR } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Segmented, Toggle } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'appearance-behavior', page: 'appearance' } as const;
registerSetting({ category: cat, id: 'theme',       label: 'Theme',          keywords: ['dark', 'light', 'auto'] });
registerSetting({ category: cat, id: 'density',     label: 'Density',        keywords: ['compact', 'comfortable', 'spacious'] });
registerSetting({ category: cat, id: 'tab-height',  label: 'Tab height',     keywords: ['tab', 'small', 'medium', 'large', 'strip'] });
registerSetting({ category: cat, id: 'colorful-folders', label: 'Colorful folder icons', keywords: ['folder', 'icons', 'material', 'color', 'tree'] });
registerSetting({ category: cat, id: 'accent',      label: 'Accent color',   keywords: ['hex', 'color', 'stripe'] });
registerSetting({ category: cat, id: 'font-scale',  label: 'UI font scale',  keywords: ['zoom', 'size', 'font'] });
registerSetting({ category: cat, id: 'reduce-motion', label: 'Reduce motion',keywords: ['animation', 'a11y', 'accessibility'] });
registerSetting({ category: cat, id: 'status-bar',    label: 'Status bar',     keywords: ['minimal', 'chrome', 'bottom', 'hide'] });
registerSetting({ category: cat, id: 'tab-activity',  label: 'Tab activity',   keywords: ['minimal', 'indicator', 'dot', 'busy', 'hide'] });
registerSetting({ category: cat, id: 'compact-titlebar', label: 'Compact title bar', keywords: ['minimal', 'brand', 'chrome', 'hide'] });

const ACCENT_PRESETS = ['#3574F0', '#5FB865', '#C678DD', '#E3B341', '#DB5C5C'];

export default function AppearancePage() {
  const themeMode = useAppStore((s) => s.themeMode);
  const uiDensity = useAppStore((s) => s.uiDensity);
  const tabHeight = useAppStore((s) => s.tabHeight);
  const colorfulFolderIcons = useAppStore((s) => s.colorfulFolderIcons);
  const accentColorHex = useAppStore((s) => s.accentColorHex);
  const uiFontScale = useAppStore((s) => s.uiFontScale);
  const uiReduceMotion = useAppStore((s) => s.uiReduceMotion);
  const showStatusBar = useAppStore((s) => s.showStatusBar);
  const showTabActivity = useAppStore((s) => s.showTabActivity);
  const compactTitleBar = useAppStore((s) => s.compactTitleBar);
  const {
    setThemeMode, setUiDensity, setTabHeight, setColorfulFolderIcons, setAccentColorHex, setUiFontScale, setUiReduceMotion,
    setShowStatusBar, setShowTabActivity, setCompactTitleBar,
  } = useAppStore.getState();

  return (
    <div>
      <PageHeader title="Appearance" description="Theme, density, accent color, UI font." />

      <PageSection title="Theme">
        <SettingRow label="Theme">
          <Segmented
            value={themeMode}
            onChange={setThemeMode}
            options={[
              { value: 'dark',  label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'auto',  label: 'Follow system' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Density" description="Row spacing across the app.">
          <Segmented
            value={uiDensity}
            onChange={setUiDensity}
            options={[
              { value: 'compact',     label: 'Compact' },
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'spacious',    label: 'Spacious' },
            ]}
          />
        </SettingRow>
        <SettingRow label="Tab height" description="Terminal/editor tab strip height (24 / 28 / 32 px).">
          <Segmented
            value={tabHeight}
            onChange={setTabHeight}
            options={[
              { value: 'small',  label: 'Small' },
              { value: 'medium', label: 'Medium' },
              { value: 'large',  label: 'Large' },
            ]}
          />
        </SettingRow>
        <SettingRow
          label="Colorful folder icons"
          description="When off, all folders use one yellow icon (matches the sketch). When on, folders like .git, node_modules, docs get material-icon-theme's per-name colors."
        >
          <Toggle value={colorfulFolderIcons} onChange={setColorfulFolderIcons} />
        </SettingRow>
        <SettingRow label="Accent color">
          <div className="flex gap-2 items-center">
            {ACCENT_PRESETS.map((c) => (
              <button
                key={c}
                onClick={() => setAccentColorHex(c)}
                style={{ background: c }}
                className={`w-5 h-5 rounded-md transition-transform ${
                  accentColorHex.toLowerCase() === c.toLowerCase() ? 'ring-2 ring-white scale-110' : 'hover:scale-105'
                }`}
                aria-label={`Accent ${c}`}
              />
            ))}
            <input
              type="color"
              value={accentColorHex}
              onChange={(e) => setAccentColorHex(e.target.value)}
              className="w-7 h-6 bg-transparent border-0 rounded cursor-pointer"
              aria-label="Custom accent color"
            />
            <button
              onClick={() => setAccentColorHex(DEFAULT_ACCENT_COLOR)}
              className="text-[11px] text-text-tertiary hover:text-text-secondary px-2"
            >
              Reset
            </button>
          </div>
        </SettingRow>
        <SettingRow label="UI font scale" description={`${uiFontScale.toFixed(2)}x - affects body text only.`}>
          <input
            type="range"
            min="0.85"
            max="1.25"
            step="0.05"
            value={uiFontScale}
            onChange={(e) => setUiFontScale(parseFloat(e.target.value))}
            className="w-40 accent-accent-primary"
          />
        </SettingRow>
      </PageSection>

      <PageSection title="Accessibility">
        <SettingRow label="Reduce motion" description="Disables tab-pulse, shimmer, and panel transitions.">
          <Toggle value={uiReduceMotion} onChange={setUiReduceMotion} label="Reduce motion" />
        </SettingRow>
      </PageSection>

      <PageSection title="Interface">
        <SettingRow label="Status bar" description="Show the bottom status bar (terminal counts, model, version).">
          <Toggle value={showStatusBar} onChange={setShowStatusBar} label="Status bar" />
        </SettingRow>
        <SettingRow label="Tab activity indicators" description="Show the busy dot and working shimmer on tabs.">
          <Toggle value={showTabActivity} onChange={setShowTabActivity} label="Tab activity indicators" />
        </SettingRow>
        <SettingRow label="Compact title bar" description="Hide the centered product name to free up the drag area.">
          <Toggle value={compactTitleBar} onChange={setCompactTitleBar} label="Compact title bar" />
        </SettingRow>
      </PageSection>
    </div>
  );
}
