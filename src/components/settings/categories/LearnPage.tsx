import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from '../../../store/toastStore';
import { reportInvokeFailure } from '../../../lib/errorReporter';
import { useAppStore } from '../../../store/appStore';
import { PageHeader, PageSection, SettingRow, Toggle } from '../SettingRow';
import { registerSetting } from '../index';

const cat = { group: 'claude', page: 'learn' } as const;
[
  { id: 'learn-enabled', label: 'Learn from agent changes' },
  { id: 'learn-consent', label: 'Allow Learn to send the session diff to Claude' },
].forEach(({ id, label }) =>
  registerSetting({ category: cat, id, label, keywords: ['learn', 'lessons', 'tutor', 'education', 'teach', 'quiz'] })
);

export default function LearnPage() {
  const learnEnabled = useAppStore((s) => s.learnEnabled);
  const setLearnEnabled = useAppStore((s) => s.setLearnEnabled);
  const [consent, setConsent] = useState(false);
  useEffect(() => {
    invoke<boolean>('get_learn_consent').then(setConsent).catch(() => {
      // Fail closed: the backend also checks consent on every request.
    });
  }, []);

  return (
    <div>
      <PageHeader title="Learn" />
      <PageSection title="Learn Cards">
        <SettingRow
          label="Learn from agent changes"
          description="On by default. Shows the Learn tab in the Inspector. After an agent changes code, Learn turns the diff into 1-3 short lessons with a quick question, so you understand what was built."
        >
          <Toggle label="Learn from agent changes" value={learnEnabled} onChange={setLearnEnabled} />
        </SettingRow>
        <SettingRow
          label="Allow Learn to send the session diff to Claude"
          description="Off until you allow it. Sends up to 24 KiB of the session's git diff to the model service configured in your Claude CLI. Known secrets are scrubbed, but source code is sent. Without this, Learn does not write lessons."
        >
          <Toggle
            label="Allow Learn to send the session diff to Claude"
            value={consent}
            onChange={(enabled) => {
              invoke('set_learn_consent', { enabled })
                .then(() => setConsent(enabled))
                .catch((err) => {
                  toast.error('Could not change the Learn preference');
                  reportInvokeFailure('set_learn_consent', err);
                });
            }}
          />
        </SettingRow>
      </PageSection>
    </div>
  );
}
