import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuthStore } from '../store/authStore';
import { logout } from '../lib/auth';
import { LoginModal } from './LoginModal';
import { reportInvokeFailure } from '../lib/errorReporter';
import { useSyncStore } from '../store/syncStore';
import { setSyncEnabled } from '../lib/sync';

/**
 * Titlebar auth widget - guest sees a "Sign in" pill; authed users see a chip
 * with avatar/initials + name, clicking opens a dropdown with "Sign out".
 *
 * Rendered in TitleBar.tsx (Task 27). Follows the SessionWidget popover
 * pattern for consistency: `material-popover` surface, outside-click +
 * Escape to close, `aria-haspopup="menu"` + `aria-expanded` on the trigger.
 *
 * `mode === 'unknown'` renders nothing - App.tsx's first-launch LoginModal
 * covers that state so we don't flash a stale chip during rehydrate_auth.
 */
export function HeaderAuth() {
  // All hooks MUST be declared before any conditional return — React tracks
  // hook order by call index, so a mode transition from 'unknown' → 'authed'
  // would blow up (Rendered more hooks than during the previous render).
  const mode = useAuthStore((s) => s.mode);
  const user = useAuthStore((s) => s.user);
  const [showLogin, setShowLogin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popPos, setPopPos] = useState<{ top: number; right: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on outside click + Escape. Because the popover is portalled out of
  // the trigger's DOM subtree, `menuRef.contains(target)` is no longer
  // sufficient — we also check `popRef` to keep clicks inside the popover
  // (like the Sign out button) from triggering a close-before-click race.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      const insideTrigger = menuRef.current?.contains(target);
      const insidePopover = popRef.current?.contains(target);
      if (!insideTrigger && !insidePopover) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // When the menu opens, measure the chip's position so the portalled popover
  // can align to it. `useLayoutEffect` avoids a first-frame position flash.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPopPos({
      top: Math.round(rect.bottom + 4),
      right: Math.round(window.innerWidth - rect.right),
    });
  }, [menuOpen]);

  if (mode === 'unknown') return null;

  if (mode === 'guest') {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowLogin(true)}
          className="no-drag h-7 px-2.5 flex items-center rounded-md text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-fill-hover transition-colors"
        >
          Sign in
        </button>
        {showLogin && <LoginModal onClose={() => setShowLogin(false)} />}
      </>
    );
  }

  // mode === 'authed'
  const label = user?.name ?? user?.email ?? 'Signed in';
  const chipInitials = initials(label);

  const handleSignOut = async () => {
    setMenuOpen(false);
    try {
      await logout();
    } catch (err) {
      reportInvokeFailure('logout', err);
    }
  };

  return (
    <div className="relative no-drag" ref={menuRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Account - ${label}`}
        className={`h-7 pl-1 pr-2 flex items-center gap-1.5 rounded-md transition-colors ${
          menuOpen ? 'bg-fill-active' : 'hover:bg-fill-hover'
        }`}
      >
        {user?.image ? (
          <img
            src={user.image}
            alt=""
            className="w-5 h-5 rounded-full object-cover"
            draggable={false}
          />
        ) : (
          <span className="w-5 h-5 rounded-full bg-accent-primary text-white text-[10px] font-semibold flex items-center justify-center">
            {chipInitials}
          </span>
        )}
        <span className="text-[12px] font-medium text-text-primary truncate max-w-[140px]">
          {label}
        </span>
      </button>

      {menuOpen && popPos !== null &&
        createPortal(
          <div
            ref={popRef}
            role="menu"
            // Escape TitleBar's transforms while retaining React event handling.
            className="no-drag fixed w-[240px] material-popover rounded-lg overflow-hidden"
            style={{ top: popPos.top, right: popPos.right, zIndex: 1000 }}
          >
            <div className="px-3 py-2 border-b border-seam">
              <div className="text-[12px] font-medium text-text-primary truncate">
                {user?.name ?? '(no name)'}
              </div>
              {user?.email && (
                <div className="text-[11px] text-text-tertiary truncate">
                  {user.email}
                </div>
              )}
            </div>
            <div className="px-3 py-2 border-b border-seam flex items-center justify-between">
              <span className="text-[12px] text-text-secondary">Sync</span>
              <SyncToggle />
            </div>
            <button
              type="button"
              role="menuitem"
              onClick={handleSignOut}
              className="w-full px-3 py-2 text-left text-[12px] text-text-secondary hover:text-text-primary hover:bg-fill-hover transition-colors"
            >
              Sign out
            </button>
          </div>,
          document.getElementById('root') ?? document.body,
        )}
    </div>
  );
}

/**
 * "Tal Ayash" -> "TA"; "tal@example.com" -> "T"; empty -> "?".
 * Purely a visual fallback for when `user.image` is null.
 */
function initials(s: string): string {
  const parts = s.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0][0] ?? '?').toUpperCase();
  return ((parts[0][0] ?? '') + (parts[1][0] ?? '')).toUpperCase();
}

function SyncToggle() {
  const enabled = useSyncStore((s) => s.enabled);
  const [busy, setBusy] = useState(false);

  const handleToggle = async () => {
    setBusy(true);
    try {
      await setSyncEnabled(!enabled);
    } catch {
      // setSyncEnabled already reverted the UI + reported to telemetry.
    }
    setBusy(false);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      aria-label={`Sync ${enabled ? 'on' : 'off'}`}
      onClick={handleToggle}
      disabled={busy}
      className={`relative w-8 h-4 rounded-full transition-colors ${
        enabled ? 'bg-accent-primary' : 'bg-elevation-1 ring-1 ring-inset ring-seam'
      } disabled:opacity-50`}
    >
      <span
        className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-transform ${
          enabled ? 'translate-x-4' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
