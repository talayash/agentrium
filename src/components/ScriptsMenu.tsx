import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Play, ChevronDown, Square, Loader2, Package } from 'lucide-react';
import { useTerminalStore } from '../store/terminalStore';
import { toast } from '../store/toastStore';

interface PackageScript {
  name: string;
  command: string;
}

interface ScriptsMenuProps {
  terminalId: string;
  cwd: string;
}

/**
 * Dropdown that lists scripts from package.json in the terminal's cwd and
 * spawns them as child terminals (visible split-below in the same tab).
 * Auto-hides when there are no scripts - users see nothing for non-JS dirs.
 */
export function ScriptsMenu({ terminalId, cwd }: ScriptsMenuProps) {
  const [scripts, setScripts] = useState<PackageScript[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const scriptChildren = useTerminalStore((s) => s.scriptChildren);
  const terminals = useTerminalStore((s) => s.terminals);
  const runScript = useTerminalStore((s) => s.runScript);
  const closeScript = useTerminalStore((s) => s.closeScript);

  const childId = scriptChildren.get(terminalId);
  const childInstance = childId ? terminals.get(childId) : undefined;
  const activeScriptName = childInstance?.scriptName ?? null;

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      try {
        const list = await invoke<PackageScript[]>('list_package_scripts', { cwd });
        if (!cancelled) setScripts(list);
      } catch {
        if (!cancelled) setScripts([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => { cancelled = true; };
  }, [cwd]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const handleRun = async (scriptName: string) => {
    setOpen(false);
    setRunning(true);
    try {
      await runScript(terminalId, scriptName);
    } catch (err) {
      toast.error('Failed to run script', typeof err === 'string' ? err : 'Unknown error');
    } finally {
      setRunning(false);
    }
  };

  const handleStop = async () => {
    try {
      await closeScript(terminalId);
    } catch (err) {
      toast.error('Failed to stop', typeof err === 'string' ? err : 'Unknown error');
    }
  };

  // Silently hide when there are no scripts - don't pollute the UI for
  // terminals that aren't in a Node project.
  if (!loading && scripts.length === 0) return null;

  return (
    <div ref={containerRef} className="relative">
      {activeScriptName ? (
        <button
          onClick={handleStop}
          className="flex items-center gap-1 h-6 px-2 rounded-[4px] text-[11px] bg-red-500/15 text-red-400 hover:bg-red-500/25 transition-colors"
          title={`Stop npm run ${activeScriptName}`}
        >
          <Square size={11} strokeWidth={1.75} />
          <span className="font-mono max-w-[80px] truncate">{activeScriptName}</span>
        </button>
      ) : (
        <button
          onClick={() => setOpen((v) => !v)}
          disabled={loading || running}
          className="flex items-center gap-1 h-6 px-2 rounded-[4px] text-[11px] text-text-secondary hover:bg-white/[0.06] hover:text-text-primary transition-colors disabled:opacity-50"
          title="Run a package.json script"
        >
          {loading || running ? <Loader2 size={11} className="animate-spin" /> : <Package size={11} strokeWidth={1.75} />}
          Scripts
          <ChevronDown size={10} className="opacity-60" strokeWidth={1.75} />
        </button>
      )}

      {open && scripts.length > 0 && (
        <div className="absolute right-0 top-full mt-1 z-30 bg-elevation-3 ring-1 ring-white/[0.08] rounded-lg py-1 min-w-[240px] max-w-[360px] max-h-[50vh] overflow-y-auto">
          <div className="px-3 py-1.5 text-[10.5px] uppercase tracking-wide text-text-tertiary border-b border-[var(--ij-divider-soft)] mb-1">
            package.json scripts
          </div>
          {scripts.map((script) => (
            <button
              key={script.name}
              onClick={() => handleRun(script.name)}
              className="w-full text-left flex flex-col gap-0.5 px-3 py-1.5 hover:bg-white/[0.05] transition-colors"
            >
              <div className="flex items-center gap-1.5">
                <Play size={10} className="text-accent-primary flex-shrink-0" strokeWidth={2} />
                <span className="text-[12px] font-medium text-text-primary truncate">{script.name}</span>
              </div>
              <span className="text-[10.5px] text-text-tertiary font-mono truncate pl-[18px]" title={script.command}>
                {script.command}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
