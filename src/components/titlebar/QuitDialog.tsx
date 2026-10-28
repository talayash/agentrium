import { create } from 'zustand';
import { AnimatePresence } from 'framer-motion';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useTerminalStore } from '../../store/terminalStore';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import appIcon from '../../assets/app-icon.png';

interface QuitPromptState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

/** Whether the main window's "Quit Agentrium?" sheet is showing. */
export const useQuitPrompt = create<QuitPromptState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/**
 * In-app confirmation for the main window's close button. Closing the main
 * window quits the whole app and ends every session, so it asks first, styled
 * like the update sheet rather than a native OS dialog. Mounted once, in the
 * main window only (App.tsx).
 */
export function QuitDialog() {
  const open = useQuitPrompt((s) => s.open);
  const setOpen = useQuitPrompt((s) => s.setOpen);
  const sessionCount = useTerminalStore(
    (s) => Array.from(s.terminals.values()).filter((t) => !t.scriptParentId && !t.isShellTerminal).length
  );

  const cancel = () => setOpen(false);
  const quit = () => {
    setOpen(false);
    // The Rust CloseRequested handler on "main" saves the session and exits.
    void getCurrentWindow().close();
  };

  return (
    <AnimatePresence>
      {open && (
        <Modal key="quit-sheet" onClose={cancel} panelClassName="w-[360px]" scrimClassName="bg-black/45 z-[90]">
          <div className="flex flex-col items-center px-[26px] pb-5 pt-[28px]">
            <img src={appIcon} alt="" draggable={false} className="h-14 w-14" />
            <h2 className="mt-4 text-center text-[16px] font-semibold tracking-title text-text-primary">
              Quit Agentrium?
            </h2>
            <p className="mt-1.5 text-center text-[12px] text-text-secondary">
              {sessionCount > 0
                ? `${sessionCount} open session${sessionCount === 1 ? '' : 's'} will be closed.`
                : 'The app will close.'}
            </p>
            <div className="mt-5 flex w-full gap-2">
              <Button variant="secondary" size="sm" className="flex-1" onClick={cancel}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" className="flex-1" onClick={quit}>
                Quit
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </AnimatePresence>
  );
}
