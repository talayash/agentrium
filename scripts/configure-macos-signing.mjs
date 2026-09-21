// Pass Apple credentials to subsequent CI steps only when fully configured.
// Empty environment variables are not equivalent to absent ones in Tauri.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const keys = [
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
];
const missing = keys.filter(key => !process.env[key]?.trim());

if (missing.length === keys.length) {
  console.log('::warning::Apple signing is not configured. macOS updates may prompt for Keychain access again. See docs/macos-signing-plan.md.');
} else if (missing.length) {
  console.error(`::error::Incomplete macOS signing configuration. Missing: ${missing.join(', ')}`);
  process.exitCode = 1;
} else if (!process.env.APPLE_SIGNING_IDENTITY.startsWith('Developer ID Application:')) {
  console.error('::error::APPLE_SIGNING_IDENTITY must be a Developer ID Application identity for distribution.');
  process.exitCode = 1;
} else {
  // Multiline syntax preserves exported base64 certificates and keeps values
  // out of the shell and logs. GitHub masks the configured repository secrets.
  const content = keys.map(key => {
    const delimiter = `agentrium_${randomUUID()}`;
    return `${key}<<${delimiter}\n${process.env[key]}\n${delimiter}\n`;
  }).join('');
  appendFileSync(process.env.GITHUB_ENV, content);
  console.log('macOS signing and notarization configured.');
}
