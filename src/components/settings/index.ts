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
  { id: 'claude', label: 'Agents', pages: [
    { id: 'agents-keys', label: 'Agents & Keys' },
    { id: 'defaults',    label: 'Agent Defaults' },
    { id: 'learn',       label: 'Learn' },
    { id: 'updates',     label: 'Agent Updates' },
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

export function pageKey(c: CategoryId): string {
  return `${c.group}.${c.page}`;
}

export type NavSectionId =
  | 'general' | 'terminal' | 'editor' | 'agents' | 'git' | 'tools' | 'notifications' | 'keymap' | 'privacy-about';

// What the sidebar shows. CATEGORY_GROUPS stays the registry that pages and
// search key off; a section stacks one or more of those pages on one screen.
export const NAV_SECTIONS: {
  id: NavSectionId;
  label: string;
  description: string;
  pages: string[];
}[] = [
  { id: 'general', label: 'General', description: 'Theme, accent, interface chrome, startup and session restore.',
    pages: ['appearance-behavior.appearance', 'appearance-behavior.startup-session'] },
  { id: 'terminal', label: 'Terminal', description: 'Terminal font and colors, shell, selection and pastes.',
    pages: ['terminal.appearance', 'terminal.behavior', 'terminal.pastes'] },
  { id: 'editor', label: 'Editor', description: 'The in-app file editor (Monaco) and its language servers.',
    pages: ['editor.general', 'editor.font', 'editor.language-servers'] },
  { id: 'agents', label: 'Agents', description: 'Which coding agents Agentrium launches, their keys, defaults and updates.',
    pages: ['claude.agents-keys', 'claude.defaults', 'claude.learn', 'claude.updates'] },
  { id: 'git', label: 'Git', description: 'Version control and changelists.',
    pages: ['vcs.git', 'vcs.changelists'] },
  { id: 'tools', label: 'Tools', description: 'External launchers and the preview panel.',
    pages: ['tools.launchers', 'tools.preview'] },
  { id: 'notifications', label: 'Notifications', description: 'Alerts when responses are ready, sessions need input, or terminals finish.',
    pages: ['appearance-behavior.notifications'] },
  { id: 'keymap', label: 'Keymap', description: 'Read-only. Editing keybindings is on the roadmap.',
    pages: ['appearance-behavior.keymap'] },
  { id: 'privacy-about', label: 'Privacy & About', description: 'Telemetry choices, version and links.',
    pages: ['privacy-about.privacy', 'privacy-about.about'] },
];

export function sectionForPage(key: string): NavSectionId | undefined {
  return NAV_SECTIONS.find((s) => s.pages.includes(key))?.id;
}

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
