import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'appearance-behavior', page: 'notifications' } as const;
registerSetting({ category: cat, id: 'notify-on-finish', label: 'Notify on terminal finish', keywords: ['notification', 'desktop'] });
registerSetting({ category: cat, id: 'sound',            label: 'Notification sound',         keywords: ['audio', 'ding'] });
registerSetting({ category: cat, id: 'dnd',              label: 'Do not disturb',             keywords: ['quiet', 'hours', 'mute'] });

export default function NotificationsPage() {
  const notifyOnFinish = useAppStore((s) => s.notifyOnFinish);
  const notificationSoundEnabled = useAppStore((s) => s.notificationSoundEnabled);
  const dndEnabled = useAppStore((s) => s.dndEnabled);
  const dndStart = useAppStore((s) => s.dndStart);
  const dndEnd = useAppStore((s) => s.dndEnd);
  const {
    setNotifyOnFinish, setNotificationSoundEnabled,
    setDndEnabled, setDndStart, setDndEnd,
  } = useAppStore.getState();

  return (
    <div>
      <PageHeader title="Notifications" description="Desktop notifications when terminals finish." />

      <PageSection title="Events">
        <SettingRow label="Notify when terminal finishes" description="System notification on PTY exit.">
          <Toggle value={notifyOnFinish} onChange={setNotifyOnFinish} />
        </SettingRow>
        <SettingRow label="Play sound" description="Adds a short sound on notification.">
          <Toggle value={notificationSoundEnabled} onChange={setNotificationSoundEnabled} />
        </SettingRow>
      </PageSection>

      <PageSection title="Do not disturb" description="Suppress desktop notifications during these hours.">
        <SettingRow label="Enable DND window">
          <Toggle value={dndEnabled} onChange={setDndEnabled} />
        </SettingRow>
        <SettingRow label="Start (HH:mm)">
          <input
            type="time"
            value={dndStart}
            onChange={(e) => setDndStart(e.target.value)}
            disabled={!dndEnabled}
            className="bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light disabled:opacity-40"
          />
        </SettingRow>
        <SettingRow label="End (HH:mm)">
          <input
            type="time"
            value={dndEnd}
            onChange={(e) => setDndEnd(e.target.value)}
            disabled={!dndEnabled}
            className="bg-elevation-0 text-text-primary text-[12px] px-2 py-1 rounded ring-1 ring-border-light disabled:opacity-40"
          />
        </SettingRow>
      </PageSection>
    </div>
  );
}
