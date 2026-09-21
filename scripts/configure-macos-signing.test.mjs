import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const credentials = {
  APPLE_CERTIFICATE: 'test-base64-line-1\ntest-base64-line-2',
  APPLE_CERTIFICATE_PASSWORD: 'test-p12-password',
  APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test (TESTTEAM01)',
  APPLE_ID: 'test@example.com',
  APPLE_PASSWORD: 'test-notary-password',
  APPLE_TEAM_ID: 'TESTTEAM01',
};

function run(overrides) {
  const directory = mkdtempSync(join(tmpdir(), 'agentrium-signing-'));
  try {
    const envFile = join(directory, 'env');
    writeFileSync(envFile, '');
    const env = { ...process.env, GITHUB_ENV: envFile };
    for (const key of Object.keys(credentials)) delete env[key];
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./configure-macos-signing.mjs', import.meta.url))], {
      env: { ...env, ...overrides }, encoding: 'utf8',
    });
    assert.ifError(result.error);
    return { ...result, exported: readFileSync(envFile, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('unconfigured releases warn and leave Apple environment variables absent', () => {
  const result = run(Object.fromEntries(Object.keys(credentials).map(key => [key, ''])));
  assert.equal(result.status, 0);
  assert.match(result.stdout, /::warning::/);
  assert.equal(result.exported, '');
});

test('partial configuration fails without exporting secrets', () => {
  const result = run({ APPLE_CERTIFICATE: credentials.APPLE_CERTIFICATE });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Missing: APPLE_CERTIFICATE_PASSWORD/);
  assert.equal(result.exported, '');
});

test('ad-hoc and development identities cannot masquerade as distribution signing', () => {
  for (const identity of ['-', 'Apple Development: Test (TESTTEAM01)']) {
    const result = run({ ...credentials, APPLE_SIGNING_IDENTITY: identity });
    assert.equal(result.status, 1);
    assert.equal(result.exported, '');
  }
});

test('complete configuration exports exact values without logging secrets', () => {
  const result = run(credentials);
  assert.equal(result.status, 0);
  for (const [key, value] of Object.entries(credentials)) {
    const delimiter = result.exported.match(new RegExp(`${key}<<(agentrium_[^\\n]+)`))?.[1];
    assert.ok(delimiter);
    assert.ok(result.exported.includes(`${key}<<${delimiter}\n${value}\n${delimiter}\n`));
    assert.ok(!(result.stdout + result.stderr).includes(value));
  }
});
