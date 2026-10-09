import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildUpdaterJson, expectedPlatforms } from './build-updater-json.mjs';

// The real v1.38.0 asset list, as tauri-action uploaded it.
const ASSETS_1_38_0 = [
  'Agentrium_1.38.0_aarch64.dmg',
  'Agentrium_1.38.0_x64-setup.exe',
  'Agentrium_1.38.0_x64-setup.exe.sig',
  'Agentrium_1.38.0_x64.dmg',
  'Agentrium_1.38.0_x64_en-US.msi',
  'Agentrium_1.38.0_x64_en-US.msi.sig',
  'Agentrium_aarch64.app.tar.gz',
  'Agentrium_aarch64.app.tar.gz.sig',
  'Agentrium_x64.app.tar.gz',
  'Agentrium_x64.app.tar.gz.sig',
  'latest.json',
];

const sigsFor = (names) =>
  Object.fromEntries(names.filter((n) => n.endsWith('.sig')).map((n) => [n, `sig-of:${n}\n`]));

const build = (assetNames, signatures = sigsFor(assetNames)) =>
  buildUpdaterJson({
    repo: 'talayash/agentrium',
    version: '1.38.0',
    pubDate: '2026-10-05T18:26:52.924Z',
    assetNames,
    signatures,
  });

test('emits every platform key the shipped updater resolves', () => {
  const manifest = build(ASSETS_1_38_0);
  assert.deepEqual(Object.keys(manifest.platforms).sort(), [
    'darwin-aarch64',
    'darwin-aarch64-app',
    'darwin-x86_64',
    'darwin-x86_64-app',
    'windows-x86_64',
    'windows-x86_64-msi',
    'windows-x86_64-nsis',
  ]);
  assert.equal(manifest.version, '1.38.0');
  assert.equal(manifest.pub_date, '2026-10-05T18:26:52.924Z');
  assert.equal(manifest.notes, '');
});

test('matches the url and signature shape tauri-action produced', () => {
  const { platforms } = build(ASSETS_1_38_0);
  assert.deepEqual(platforms['darwin-aarch64-app'], {
    signature: 'sig-of:Agentrium_aarch64.app.tar.gz.sig',
    url: 'https://github.com/talayash/agentrium/releases/latest/download/Agentrium_aarch64.app.tar.gz',
  });
  // Bare windows key prefers NSIS, as updaterJsonPreferNsis did.
  assert.equal(platforms['windows-x86_64'].url, platforms['windows-x86_64-nsis'].url);
  assert.match(platforms['windows-x86_64-msi'].url, /Agentrium_1\.38\.0_x64_en-US\.msi$/);
});

test('refuses to build when an architecture is missing (the v1.38.0 race)', () => {
  const withoutArm = ASSETS_1_38_0.filter((n) => !n.startsWith('Agentrium_aarch64.app'));
  assert.throws(() => build(withoutArm), /Agentrium_aarch64\.app\.tar\.gz, Agentrium_aarch64\.app\.tar\.gz\.sig/);
});

test('refuses an artifact whose signature file is empty', () => {
  const sigs = sigsFor(ASSETS_1_38_0);
  sigs['Agentrium_1.38.0_x64_en-US.msi.sig'] = '  \n';
  assert.throws(() => build(ASSETS_1_38_0, sigs), /Agentrium_1\.38\.0_x64_en-US\.msi\.sig/);
});

test('versioned windows artifact names follow the version', () => {
  assert.equal(expectedPlatforms('2.0.1')['windows-x86_64-nsis'], 'Agentrium_2.0.1_x64-setup.exe');
});
