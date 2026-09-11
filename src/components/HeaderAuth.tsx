import { useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { logout } from '../lib/auth';
import { LoginModal } from './LoginModal';
import { reportInvokeFailure } from '../lib/errorReporter';

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
  const mode = useAuthStore((s) => s.mode);
  const user = useAuthStore((s) => s.user);
  const [showLogin, setShowLogin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close on outside click + Escape - same pattern as SessionWidget.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
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

      {menuOpen && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-50 w-[240px] material-popover rounded-lg overflow-hidden"
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
          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary hover:text-text-primary hover:bg-fill-hover transition-colors"
          >
            <LogOut size={12} strokeWidth={1.75} className="text-text-tertiary" />
            Sign out
          </button>
        </div>
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
