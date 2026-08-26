import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Users, User, Crown, ExternalLink, ChevronDown, ChevronRight, ListTodo } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { useTerminalStore } from '../store/terminalStore';
import { reportInvokeFailure } from '../lib/errorReporter';

interface TeamMember {
  agentId: string;
  name: string;
  agentType: string;
  model?: string;
  joinedAt?: number;
  cwd?: string;
}

interface TeamConfig {
  name: string;
  description?: string;
  createdAt?: number;
  leadAgentId?: string;
  members: TeamMember[];
}

interface TeamInfo {
  dirName: string;
  config: TeamConfig;
  taskCount?: number;
}

interface TaskInfo {
  id: string;
  subject: string;
  status: string;
  owner: string | null;
  blockedBy: string[];
  activeForm: string | null;
}

function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/').replace(/\/+$/, '');
}

export function OrchestrationPanel() {
  const [teams, setTeams] = useState<TeamInfo[]>([]);
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Map<string, TaskInfo[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const terminals = useTerminalStore((s) => s.terminals);
  const setActiveTerminal = useTerminalStore((s) => s.setActiveTerminal);

  // useCallback with expandedTeam in deps: without this, the polling interval
  // below closes over the first-render fetchTeams (with a stale expandedTeam),
  // and expanded-team task refreshes never actually see the current expansion.
  const fetchTeams = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<TeamInfo[]>('get_active_teams');
      setTeams(result);

      // Fetch tasks for expanded team
      if (expandedTeam) {
        try {
          const teamTasks = await invoke<TaskInfo[]>('get_team_tasks', { teamName: expandedTeam });
          setTasks((prev) => {
            const next = new Map(prev);
            next.set(expandedTeam, teamTasks);
            return next;
          });
        } catch {
          /* task list is best-effort - panel still renders the team without it */
        }
      }
    } catch (err) {
      reportInvokeFailure('get_active_teams', err);
    } finally {
      setLoading(false);
    }
  }, [expandedTeam]);

  const handleExpand = async (dirName: string) => {
    const newExpanded = expandedTeam === dirName ? null : dirName;
    setExpandedTeam(newExpanded);

    if (newExpanded) {
      try {
        const teamTasks = await invoke<TaskInfo[]>('get_team_tasks', { teamName: newExpanded });
        setTasks((prev) => {
          const next = new Map(prev);
          next.set(newExpanded, teamTasks);
          return next;
        });
      } catch {
        // Task fetch failed silently
      }
    }
  };

  useEffect(() => {
    fetchTeams();
    const interval = setInterval(fetchTeams, 3000);
    return () => clearInterval(interval);
  }, [fetchTeams]);

  const findMatchingTerminal = (cwd: string): string | null => {
    const normalized = normalizePath(cwd);
    for (const [id, instance] of terminals) {
      if (normalizePath(instance.config.working_directory) === normalized) {
        return id;
      }
    }
    return null;
  };

  return (
    <div className="h-full bg-bg-secondary border-l border-border flex flex-col">
      {/* Header */}
      <div className="p-3 border-b border-border">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="text-text-primary text-[13px] font-semibold">Agent Teams</h3>
            {teams.length > 0 && (
              <span className="bg-accent-primary/15 text-accent-primary text-[10px] font-medium px-1.5 py-0.5 rounded-full">
                {teams.length}
              </span>
            )}
          </div>
          <button
            onClick={fetchTeams}
            className="p-1 rounded hover:bg-white/[0.04] text-text-secondary transition-colors"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-1.5">
        {teams.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-4">
            <Users size={32} className="text-text-tertiary mb-3" />
            <p className="text-text-secondary text-[13px] font-medium mb-1">No Active Teams</p>
            <p className="text-text-tertiary text-[11px]">
              When a Claude Code session spawns a team, it will appear here.
            </p>
          </div>
        ) : (
          teams.map((team) => {
            const isExpanded = expandedTeam === team.dirName;
            const leader = team.config.leadAgentId
              ? team.config.members.find((m) => m.agentId === team.config.leadAgentId)
              : null;
            const teammates = team.config.members.filter(
              (m) => m.agentId !== team.config.leadAgentId
            );

            return (
              <div key={team.dirName} className="mb-1">
                <button
                  onClick={() => handleExpand(team.dirName)}
                  className="w-full flex items-center gap-2 p-2 rounded-md hover:bg-white/[0.04] transition-colors"
                >
                  {isExpanded ? (
                    <ChevronDown size={14} className="text-text-tertiary shrink-0" />
                  ) : (
                    <ChevronRight size={14} className="text-text-tertiary shrink-0" />
                  )}
                  <div className="flex-1 text-left min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-text-primary text-[12px] font-medium truncate">
                        {team.config.name}
                      </span>
                      <span className="text-text-tertiary text-[10px] shrink-0">
                        {team.config.members.length} member{team.config.members.length !== 1 ? 's' : ''}
                      </span>
                    </div>
                    {team.config.description && (
                      <p className="text-text-tertiary text-[11px] truncate mt-0.5">
                        {team.config.description}
                      </p>
                    )}
                  </div>
                  {team.taskCount != null && (
                    <span
                      className="flex items-center gap-1 bg-bg-primary ring-1 ring-border text-text-secondary text-[10px] px-1.5 py-0.5 rounded shrink-0"
                      title={`${team.taskCount} task${team.taskCount !== 1 ? 's' : ''}`}
                    >
                      <ListTodo size={10} />
                      {team.taskCount}
                    </span>
                  )}
                </button>

                {isExpanded && (
                  <div className="ml-4 mt-0.5">
                    {/* Leader */}
                    {leader && (
                      <MemberRow
                        member={leader}
                        isLeader
                        findMatchingTerminal={findMatchingTerminal}
                        setActiveTerminal={setActiveTerminal}
                      />
                    )}

                    {/* Teammates */}
                    {teammates.map((member, idx) => (
                      <div key={member.agentId} className="relative">
                        {/* Tree line */}
                        <div
                          className="absolute left-0 top-0 border-l border-border"
                          style={{ height: idx === teammates.length - 1 ? '50%' : '100%' }}
                        />
                        <div className="absolute left-0 top-1/2 w-3 border-b border-border" />
                        <div className="ml-4">
                          <MemberRow
                            member={member}
                            isLeader={false}
                            findMatchingTerminal={findMatchingTerminal}
                            setActiveTerminal={setActiveTerminal}
                          />
                        </div>
                      </div>
                    ))}

                    {/* Task Board */}
                    {tasks.get(team.dirName) && tasks.get(team.dirName)!.length > 0 && (
                      <div className="mt-2 pt-2 border-t border-border/50">
                        <div className="flex items-center gap-1.5 px-1.5 mb-1.5">
                          <ListTodo size={11} className="text-text-tertiary" />
                          <span className="text-text-tertiary text-[10px] font-medium uppercase tracking-wider">Tasks</span>
                        </div>
                        {tasks.get(team.dirName)!.map((task) => (
                          <div key={task.id} className="flex items-start gap-2 p-1.5 rounded-md hover:bg-white/[0.02]">
                            <div className="mt-1 flex-shrink-0">
                              <div
                                className={`w-2 h-2 rounded-full ${
                                  task.status === 'completed' ? 'bg-success' :
                                  task.status === 'in_progress' ? 'bg-warning animate-pulse' :
                                  'bg-text-tertiary'
                                }`}
                              />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className={`text-[11px] truncate ${
                                task.status === 'completed' ? 'text-text-tertiary line-through' : 'text-text-primary'
                              }`}>
                                {task.status === 'in_progress' && task.activeForm
                                  ? task.activeForm
                                  : task.subject}
                              </p>
                              <div className="flex items-center gap-1.5 mt-0.5">
                                {task.owner && (
                                  <span className="text-[9px] text-text-tertiary bg-bg-primary px-1 rounded">
                                    {task.owner}
                                  </span>
                                )}
                                {task.blockedBy.length > 0 && (
                                  <span className="text-[9px] text-warning bg-warning/10 px-1 rounded">
                                    blocked
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Footer */}
      <div className="p-2 border-t border-border">
        <div className="flex items-center justify-between px-1">
          <span className="text-text-tertiary text-[10px]">Auto-refreshing every 3s</span>
          <span className="text-text-tertiary text-[10px]">
            <kbd className="bg-bg-elevated px-1 rounded text-[10px]">F4</kbd> to toggle
          </span>
        </div>
      </div>
    </div>
  );
}

function MemberRow({
  member,
  isLeader,
  findMatchingTerminal,
  setActiveTerminal,
}: {
  member: TeamMember;
  isLeader: boolean;
  findMatchingTerminal: (cwd: string) => string | null;
  setActiveTerminal: (id: string) => void;
}) {
  const matchedTerminalId = member.cwd ? findMatchingTerminal(member.cwd) : null;

  return (
    <div className="flex items-center gap-2 p-1.5 rounded-md hover:bg-white/[0.04] group">
      {isLeader ? (
        <Crown size={12} className="text-yellow-400 shrink-0" />
      ) : (
        <User size={12} className="text-text-tertiary shrink-0" />
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className={`text-[12px] font-medium truncate ${isLeader ? 'text-yellow-300' : 'text-text-primary'}`}>
            {member.name}
          </span>
          <span className="text-text-tertiary text-[10px] shrink-0">
            {member.agentType}
          </span>
        </div>
        {member.model && (
          <span className="text-[10px] text-accent-primary/70 bg-accent-primary/10 px-1 rounded mt-0.5 inline-block">
            {member.model}
          </span>
        )}
      </div>
      {matchedTerminalId && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setActiveTerminal(matchedTerminalId);
          }}
          className="p-1 rounded hover:bg-white/[0.06] opacity-0 group-hover:opacity-100 transition-opacity text-text-tertiary hover:text-accent-primary"
          title="Jump to terminal"
        >
          <ExternalLink size={12} />
        </button>
      )}
    </div>
  );
}
