import { Bell, BellOff } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { Tooltip } from '../ui/Tooltip';

/**
 * Titlebar notifications control (relocated from the status bar). Click
 * toggles finish-notifications; the accent dot marks unread ones and clears
 * on click.
 */
export function NotificationBell() {
  const notifyOnFinish = useAppStore((s) => s.notifyOnFinish);
  const setNotifyOnFinish = useAppStore((s) => s.setNotifyOnFinish);
  const unreadCount = useAppStore((s) => s.unreadNotificationCount);
  const clearUnread = useAppStore((s) => s.clearUnreadNotifications);

  return (
    <Tooltip
      label={
        unreadCount > 0
          ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}`
          : notifyOnFinish ? 'Notifications on' : 'Notifications off'
      }
    >
      <button
        onClick={() => {
          setNotifyOnFinish(!notifyOnFinish);
          if (unreadCount > 0) clearUnread();
        }}
        aria-label={notifyOnFinish ? 'Turn notifications off' : 'Turn notifications on'}
        className={`no-drag relative w-7 h-7 flex items-center justify-center rounded-md transition-[background-color,color,transform] duration-100 active:scale-95 hover:bg-fill-hover ${
          notifyOnFinish ? 'text-text-secondary hover:text-text-primary' : 'text-text-tertiary hover:text-text-secondary'
        }`}
      >
        {notifyOnFinish ? <Bell size={15} strokeWidth={1.9} /> : <BellOff size={15} strokeWidth={1.9} />}
        {unreadCount > 0 && (
          <span
            aria-hidden
            className="absolute top-[3px] right-[4px] w-[6px] h-[6px] rounded-full bg-accent-primary"
          />
        )}
      </button>
    </Tooltip>
  );
}
