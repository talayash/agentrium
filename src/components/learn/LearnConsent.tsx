import { invoke } from '@tauri-apps/api/core';
import { toast } from '../../store/toastStore';
import { reportInvokeFailure } from '../../lib/errorReporter';

export function LearnConsent({ onAllowed }: { onAllowed: () => void }) {
  const allow = () => {
    invoke('set_learn_consent', { enabled: true })
      .then(onAllowed)
      .catch((err) => {
        toast.error('Could not enable Learn');
        reportInvokeFailure('set_learn_consent', err);
      });
  };
  return (
    <div className="flex flex-col gap-3 p-4 rounded-xl border border-[var(--seam)]">
      <p className="m-0 text-[13px] leading-relaxed text-text-secondary">
        Learn reads this session's git diff (up to 24 KiB) and sends it to the model configured in your Claude CLI to
        write short lessons. Known secrets are scrubbed, but source code is sent. You can turn this off in Settings, Learn.
      </p>
      <button
        type="button"
        onClick={allow}
        className="self-start h-9 px-3.5 rounded-lg border border-accent-primary bg-accent-primary/15 text-text-primary text-[12px] font-semibold hover:bg-accent-primary/25"
      >
        Allow
      </button>
    </div>
  );
}
