import { Minus, Square, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import appIcon from '../../assets/app-icon.png';
import { Tooltip } from '../ui/Tooltip';
import { useQuitPrompt } from './QuitDialog';

export const isMac = navigator.platform.toUpperCase().includes('MAC');

/**
 * Window close button handler. Closing the main window quits the whole app and
 * ends every session, so it opens the in-app QuitDialog first. Detached windows
 * close straight through to their own onCloseRequested "return to main / close
 * terminals" prompt.
 */
function requestWindowClose() {
  const appWindow = getCurrentWindow();
  if (appWindow.label === 'main') {
    useQuitPrompt.getState().setOpen(true);
    return;
  }
  void appWindow.close();
}

/** macOS traffic lights. `vertical` stacks them for the collapsed sidebar rail. */
export function TrafficLights({ vertical = false }: { vertical?: boolean }) {
  const appWindow = getCurrentWindow();
  return (
    <div className={`flex items-center gap-1.5 no-drag ${vertical ? 'flex-col' : ''}`}>
      <button
        onClick={requestWindowClose}
        className="w-3 h-3 rounded-full bg-[#ff5f57] hover:brightness-90 transition-all"
        aria-label="Quit Agentrium"
      />
      <button
        onClick={() => appWindow.minimize()}
        className="w-3 h-3 rounded-full bg-[#febc2e] hover:brightness-90 transition-all"
        aria-label="Minimize"
      />
      <button
        onClick={() => appWindow.toggleMaximize()}
        className="w-3 h-3 rounded-full bg-[#28c840] hover:brightness-90 transition-all"
        aria-label="Maximize"
      />
    </div>
  );
}

/** Windows/Linux caption buttons as one glass capsule (concentric toolbar). */
export function CaptionButtons() {
  const appWindow = getCurrentWindow();
  const btn =
    'w-7 h-7 flex items-center justify-center rounded-full text-text-secondary transition-colors';
  return (
    <div className="glass-capsule h-8 px-0.5 no-drag">
      <button onClick={() => appWindow.minimize()} className={`${btn} hover:bg-fill-hover`} aria-label="Minimize">
        <Minus size={12} strokeWidth={1.75} />
      </button>
      <button onClick={() => appWindow.toggleMaximize()} className={`${btn} hover:bg-fill-hover`} aria-label="Maximize">
        <Square size={10} strokeWidth={1.75} />
      </button>
      <Tooltip label="Quit Agentrium">
        <button onClick={requestWindowClose} className={`${btn} hover:bg-[#E04545] hover:text-white`} aria-label="Quit Agentrium">
          <X size={13} strokeWidth={2} />
        </button>
      </Tooltip>
    </div>
  );
}

/**
 * Top of the sidebar slab: the window controls' home (macOS) plus the brand
 * mark, at toolbar height so it lines up with the floating toolbar row. It is
 * a drag region like the toolbar.
 */
export function SidebarWindowHeader({ collapsed }: { collapsed: boolean }) {
  const appWindow = getCurrentWindow();
  return (
    <div
      onMouseDown={(e) => {
        const target = e.target;
        if (e.buttons === 1 && target instanceof Element && target.closest('.no-drag') === null) {
          appWindow.startDragging();
        }
      }}
      className={`drag-region select-none flex-shrink-0 flex items-center ${
        collapsed ? 'flex-col justify-center gap-2 py-2.5' : 'h-[var(--h-toolbar)] gap-2.5 px-3.5'
      }`}
    >
      {isMac && <TrafficLights vertical={collapsed} />}
      <img src={appIcon} alt="" className="w-[24px] h-[24px]" draggable={false} />
      {!collapsed && (
        <span className="text-[13px] font-semibold text-text-primary tracking-tight">Agentrium</span>
      )}
    </div>
  );
}
