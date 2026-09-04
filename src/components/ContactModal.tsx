import { useState } from 'react';
import { Mail } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { validateFeedback, NAME_MAX, MESSAGE_MAX } from '../lib/feedbackForm';
import { toast } from '../store/toastStore';
import { reportInvokeFailure } from '../lib/errorReporter';

interface ContactModalProps {
  onClose: () => void;
}

/**
 * "Contact us" form. Rules mirror `feedback.rs::validate` so the client and
 * server agree on what a valid submission looks like. The honeypot field is
 * an unlabeled input positioned off-screen: real users never see it, bots
 * that scrape every input fill it, and the validator rejects them.
 */
export function ContactModal({ onClose }: ContactModalProps) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [honeypot, setHoneypot] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const submit = async () => {
    setError(null);
    const result = validateFeedback({ name, message, honeypot });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setSending(true);
    try {
      const outcome = await invoke<
        { kind: 'sent' } | { kind: 'saved_locally'; path: string }
      >('send_feedback', {
        payload: { name, message, honeypot },
      });
      if (outcome.kind === 'saved_locally') {
        toast.info(
          'Saved locally (dev build)',
          `No endpoint configured - message written to ${outcome.path}`,
          {
            duration: 10000,
            actions: [
              {
                label: 'Open inbox',
                variant: 'primary',
                onClick: () => {
                  invoke('open_feedback_inbox').catch((e) =>
                    reportInvokeFailure('open_feedback_inbox', e),
                  );
                },
              },
            ],
          },
        );
      } else {
        toast.success('Message sent', 'Thanks - we read every one.');
      }
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      reportInvokeFailure('send_feedback', err);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      showHeader
      title="Send us a message"
      icon={<Mail size={14} className="text-accent-primary" />}
      panelClassName="w-full max-w-md"
    >
      <div className="p-4 space-y-3">
        <div>
          <label htmlFor="feedback-name" className="block text-[11.5px] text-text-secondary mb-1">
            Your name
          </label>
          <input
            id="feedback-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={NAME_MAX}
            placeholder="e.g. Tal"
            disabled={sending}
            className="w-full bg-elevation-2 border border-[var(--seam)] rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/25 disabled:opacity-60"
          />
        </div>
        <div>
          <label htmlFor="feedback-message" className="block text-[11.5px] text-text-secondary mb-1">
            Message
          </label>
          <textarea
            id="feedback-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={MESSAGE_MAX}
            placeholder="Feedback, bug report, feature idea…"
            disabled={sending}
            rows={5}
            className="w-full bg-elevation-2 border border-[var(--seam)] rounded-md px-2.5 py-1.5 text-[13px] text-text-primary outline-none focus:border-accent-primary focus:ring-2 focus:ring-accent-primary/25 resize-y disabled:opacity-60 font-sans"
          />
          <div className="text-[11px] text-text-tertiary mt-1 flex justify-between">
            <span>No email needed. Improvements ship in future releases.</span>
            <span>{message.length}/{MESSAGE_MAX}</span>
          </div>
        </div>
        {/*
          Honeypot: positioned off-screen (not display:none, which some bots skip).
          aria-hidden + tabIndex -1 keep it out of the keyboard/screen-reader flow.
        */}
        <div
          aria-hidden="true"
          style={{ position: 'absolute', left: '-9999px', width: 1, height: 1, opacity: 0 }}
        >
          <label htmlFor="feedback-website">Website</label>
          <input
            id="feedback-website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={honeypot}
            onChange={(e) => setHoneypot(e.target.value)}
          />
        </div>
        {error && (
          <div role="alert" className="text-[12px] text-error bg-error/10 border border-error/30 rounded-md px-2.5 py-1.5">
            {error}
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-4 h-12 border-t border-[var(--seam)] bg-elevation-3">
        <span className="text-[11px] text-text-tertiary">🛡 Rate-limited · honeypot · app-signed</span>
        <div className="flex-1" />
        <Button variant="ghost" size="sm" onClick={onClose} disabled={sending}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={submit} loading={sending}>
          Send
        </Button>
      </div>
    </Modal>
  );
}
