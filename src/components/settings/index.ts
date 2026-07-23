// Public exports + searchable settings index for SettingsWindow.

export type CategoryGroupId =
  | 'appearance-behavior' | 'editor' | 'terminal' | 'vcs' | 'claude' | 'tools' | 'privacy-about';

export interface CategoryId {
  group: CategoryGroupId;
  page: string;
}

export interface SettingDescriptor {
  category: CategoryId;
  id: string;
  label: string;
  keywords: string[];
}

export const CATEGORY_GROUPS: {
  id: CategoryGroupId;
  label: string;
  pages: { id: string; label: string }[];
}[] = [
  { id: 'appearance-behavior', label: 'Appearance & Behavior', pages: [
    { id: 'appearance',      label: 'Appearance' },
    { id: 'notifications',   label: 'Notifications' },
    { id: 'startup-session', label: 'Startup & Session' },
    { id: 'keymap',          label: 'Keymap' },
  ]},
  { id: 'editor', label: 'Editor', pages: [
    { id: 'general',          label: 'General' },
    { id: 'font',             label: 'Font' },
    { id: 'language-servers', label: 'Language Servers' },
  ]},
  { id: 'terminal', label: 'Terminal', pages: [
    { id: 'appearance', label: 'Appearance' },
    { id: 'behavior',   label: 'Behavior' },
    { id: 'pastes',     label: 'Pastes' },
  ]},
  { id: 'vcs', label: 'Version Control', pages: [
    { id: 'git',         label: 'Git' },
    { id: 'changelists', label: 'Changelists' },
  ]},
  { id: 'claude', label: 'Claude Code', pages: [
    { id: 'defaults', label: 'Defaults' },
    { id: 'updates',  label: 'Updates' },
  ]},
  { id: 'tools', label: 'Tools', pages: [
    { id: 'launchers', label: 'Launchers' },
    { id: 'preview',   label: 'Preview' },
  ]},
  { id: 'privacy-about', label: 'Privacy & About', pages: [
    { id: 'privacy', label: 'Privacy' },
    { id: 'about',   label: 'About' },
  ]},
];

// Pages register their settings via `registerSetting` at import time.
const SETTINGS_INDEX: SettingDescriptor[] = [];

export function registerSetting(d: SettingDescriptor) {
  SETTINGS_INDEX.push(d);
}

export function searchSettings(query: string): SettingDescriptor[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return SETTINGS_INDEX.filter((s) =>
    s.label.toLowerCase().includes(q) ||
    s.keywords.some((k) => k.toLowerCase().includes(q))
  );
}
