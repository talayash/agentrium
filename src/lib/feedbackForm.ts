/**
 * Pure validation for the "Contact us" form. Kept out of the component so
 * both the modal and the Rust command (via mirrored rules in feedback.rs)
 * can be tested without React or Tauri.
 */

export const NAME_MAX = 60;
export const MESSAGE_MAX = 2000;

export interface FeedbackInput {
  name: string;
  message: string;
  /** Hidden field. Real users leave it empty; bots fill it. */
  honeypot: string;
}

export interface ValidFeedback {
  name: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; value: ValidFeedback }
  | { ok: false; error: string };

export function validateFeedback(input: FeedbackInput): ValidationResult {
  // Honeypot runs first so a bot that fills every field still gets a
  // "Spam detected" message rather than a hint about which field to fix.
  if (input.honeypot.length > 0) {
    return { ok: false, error: 'Spam detected' };
  }
  const name = input.name.trim();
  if (name.length === 0) {
    return { ok: false, error: 'Name is required' };
  }
  if (name.length > NAME_MAX) {
    return { ok: false, error: `Name must be ${NAME_MAX} characters or fewer` };
  }
  const message = input.message.trim();
  if (message.length === 0) {
    return { ok: false, error: 'Message is required' };
  }
  if (message.length > MESSAGE_MAX) {
    return { ok: false, error: `Message must be ${MESSAGE_MAX} characters or fewer` };
  }
  return { ok: true, value: { name, message } };
}
