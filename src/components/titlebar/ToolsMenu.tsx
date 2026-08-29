import { useState, useRef, useEffect } from 'react';
import { Wrench, ChevronDown, FolderOpen, FileText, Clock, Settings, Brain, UserCog, type LucideIcon } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { Tooltip } from '../ui/Tooltip';

interface ToolItem {
  id: string;
  label: string;
  icon: LucideIcon;
  action: () => void;
}

export function ToolsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const {
    openWorkspaceModal, openSnippetsModal, openSessionHistory,
    openSessionTimeline, openClaudeConfig, openMemoryEditor, openProfileModal,
  } = useAppStore();

  const items: ToolItem[] = [
    { id: 'workspaces',       label: 'Workspaces',       icon: FolderOpen, action: () => openWorkspaceModal() },
    { id: 'snippets',         label: 'Snippets',         icon: FileText,   action: () => openSnippetsModal() },
    { id: 'session-history',  label: 'Session History',  icon: Clock,      action: () => openSessionHistory() },
    { id: 'session-timeline', label: 'Session Timeline', icon: Clock,      action: () => openSessionTimeline() },
    { id: 'claude-config',    label: 'Claude Config',    icon: Settings,   action: () => openClaudeConfig() },
    { id: 'memory-editor',    label: 'Memory Editor',    icon: Brain,      action: () => openMemoryEditor() },
    { id: 'profiles',         label: 'Manage Profiles',  icon: UserCog,    action: () => openProfileModal() },
  ];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative no-drag" ref={ref}>
      <Tooltip label="Tools" disabled={open}>
        <button
          onClick={() => setOpen(!open)}
          className={`flex items-center gap-1 h-7 px-2 rounded-[6px] transition-colors ${
            open ? 'bg-fill-active' : 'hover:bg-fill-hover'
          }`}
          aria-label="Tools"
        >
          <Wrench size={13} strokeWidth={2} className="text-text-secondary" />
          <ChevronDown size={10} strokeWidth={2} className="text-text-tertiary" />
        </button>
      </Tooltip>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-[220px] bg-elevation-3 ring-1 ring-seam-strong rounded-lg overflow-hidden py-1">
          {items.map(({ id, label, icon: Icon, action }) => (
            <button
              key={id}
              onClick={() => { setOpen(false); action(); }}
              className="w-full flex items-center gap-2.5 px-3 py-1.5 text-[12.5px] text-text-primary hover:bg-fill-hover transition-colors"
            >
              <Icon size={13} strokeWidth={1.75} className="text-text-secondary flex-shrink-0" />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
