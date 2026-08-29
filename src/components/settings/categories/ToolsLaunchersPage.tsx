import { FolderOpen, FileText, Clock, Settings, Brain, UserCog, type LucideIcon } from 'lucide-react';
import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection } from '../SettingRow';
import { registerSetting } from '../index';

registerSetting({
  category: { group: 'tools', page: 'launchers' },
  id: 'launchers',
  label: 'Tool launchers',
  keywords: ['workspaces', 'snippets', 'profiles', 'session history', 'memory', 'claude config'],
});

interface Tool { id: string; label: string; description: string; icon: LucideIcon; action: () => void }

export default function ToolsLaunchersPage() {
  const {
    openWorkspaceModal, openSnippetsModal, openSessionHistory,
    openSessionTimeline, openClaudeConfig, openMemoryEditor, openProfileModal,
  } = useAppStore.getState();

  const tools: Tool[] = [
    { id: 'workspaces',       label: 'Workspaces',       description: 'Saved terminal layouts.',                     icon: FolderOpen, action: () => openWorkspaceModal() },
    { id: 'snippets',         label: 'Snippets',         description: 'Reusable prompt/script snippets.',            icon: FileText,   action: () => openSnippetsModal() },
    { id: 'session-history',  label: 'Session History',  description: 'Previous terminal sessions + logs.',          icon: Clock,      action: () => openSessionHistory() },
    { id: 'session-timeline', label: 'Session Timeline', description: 'Visual timeline of recent terminal events.',  icon: Clock,      action: () => openSessionTimeline() },
    { id: 'claude-config',    label: 'Claude Config',    description: '~/.claude settings / agents / commands.',     icon: Settings,   action: () => openClaudeConfig() },
    { id: 'memory-editor',    label: 'Memory Editor',    description: 'CLAUDE.md files across the workspace.',       icon: Brain,      action: () => openMemoryEditor() },
    { id: 'profiles',         label: 'Manage Profiles',  description: 'Reusable terminal configurations.',           icon: UserCog,    action: () => openProfileModal() },
  ];

  return (
    <div>
      <PageHeader
        title="Tools - Launchers"
        description="Same items as the title-bar Tools dropdown. Opens the existing modal for each."
      />

      <PageSection title="Tools">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 py-2">
          {tools.map(({ id, label, description, icon: Icon, action }) => (
            <button
              key={id}
              onClick={action}
              className="flex items-start gap-3 px-3 py-2.5 rounded-md ring-1 ring-[var(--ij-divider-soft)] bg-elevation-0 hover:bg-fill-hover text-left transition-colors"
            >
              <Icon size={16} strokeWidth={1.75} className="text-accent-primary mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-text-primary text-[12.5px] font-medium">{label}</p>
                <p className="text-text-tertiary text-[11px] mt-0.5">{description}</p>
              </div>
            </button>
          ))}
        </div>
      </PageSection>
    </div>
  );
}
