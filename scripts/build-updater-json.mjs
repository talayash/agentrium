#!/usr/bin/env node
// Assembles the updater manifest (latest.json) for one GitHub release from the
// .sig assets the build jobs uploaded, then replaces the release's latest.json.
//
// Why this exists: tauri-action merges latest.json per build job by
// download-modify-upload. The three build jobs run in parallel, so one job's
// merge can overwrite another's. v1.38.0 shipped without darwin-aarch64 that
// way and every Apple Silicon install failed its update check. Running once,
// after all builds, with every platform required, makes the manifest
// all-or-nothing: a missing artifact fails the job and the release stays a
// draft.
//
// Usage (CI or local repair):
//   GITHUB_TOKEN=... node scripts/build-updater-json.mjs <owner/repo> <release-id> <version>

import { pathToFileURL } from 'node:url';

// Every key the shipped updater may look up. Windows resolves
// windows-x86_64-{nsis,msi} first, then windows-x86_64 (NSIS preferred, as
// updaterJsonPreferNsis did); macOS resolves darwin-<arch>-app, then
// darwin-<arch>.
export function expectedPlatforms(version) {
  const nsis = `Agentrium_${version}_x64-setup.exe`;
  const msi = `Agentrium_${version}_x64_en-US.msi`;
  return {
    'darwin-aarch64': 'Agentrium_aarch64.app.tar.gz',
    'darwin-aarch64-app': 'Agentrium_aarch64.app.tar.gz',
    'darwin-x86_64': 'Agentrium_x64.app.tar.gz',
    'darwin-x86_64-app': 'Agentrium_x64.app.tar.gz',
    'windows-x86_64': nsis,
    'windows-x86_64-nsis': nsis,
    'windows-x86_64-msi': msi,
  };
}

/**
 * Pure manifest builder. `assetNames` is every asset on the release;
 * `signatures` maps "<artifact>.sig" to that file's content. Throws, naming
 * every missing file, unless all platforms resolve.
 */
export function buildUpdaterJson({ repo, version, pubDate, notes = '', assetNames, signatures }) {
  const present = new Set(assetNames);
  const platforms = {};
  const missing = new Set();
  for (const [platform, artifact] of Object.entries(expectedPlatforms(version))) {
    const sigName = `${artifact}.sig`;
    if (!present.has(artifact)) missing.add(artifact);
    const signature = signatures[sigName]?.trim();
    if (!present.has(sigName) || !signature) missing.add(sigName);
    if (missing.size) continue;
    platforms[platform] = {
      signature,
      url: `https://github.com/${repo}/releases/latest/download/${artifact}`,
    };
  }
  if (missing.size) {
    throw new Error(`updater manifest incomplete, missing release assets: ${[...missing].join(', ')}`);
  }
  return { version, notes, pub_date: pubDate, platforms };
}

async function main([repo, releaseId, version]) {
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !releaseId || !version || !token) {
    throw new Error('usage: GITHUB_TOKEN=... build-updater-json.mjs <owner/repo> <release-id> <version>');
  }
  const api = `https://api.github.com/repos/${repo}/releases/${releaseId}`;
  const headers = { authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' };
  const call = async (url, init = {}) => {
    const res = await fetch(url, { ...init, headers: { ...headers, ...init.headers } });
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${url} -> ${res.status} ${await res.text()}`);
    return res;
  };
  // Asset bytes come from the API URL (not browser_download_url) so this also
  // works while the release is still a draft.
  const download = async (asset) =>
    (await call(asset.url, { headers: { accept: 'application/octet-stream' } })).text();

  const assets = await (await call(`${api}/assets?per_page=100`)).json();
  const signatures = {};
  for (const asset of assets.filter((a) => a.name.endsWith('.sig'))) {
    signatures[asset.name] = await download(asset);
  }

  // A re-run (or a repair of a published release) keeps the original
  // pub_date and notes rather than restamping them.
  const existing = assets.find((a) => a.name === 'latest.json');
  const previous = existing ? JSON.parse(await download(existing)) : {};

  const manifest = buildUpdaterJson({
    repo,
    version,
    pubDate: previous.version === version && previous.pub_date ? previous.pub_date : new Date().toISOString(),
    notes: previous.version === version ? previous.notes ?? '' : '',
    assetNames: assets.map((a) => a.name),
    signatures,
  });

  if (existing) await call(existing.url, { method: 'DELETE' });
  await call(`https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=latest.json`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(manifest, null, 2),
  });
  console.log(`latest.json for v${version}: ${Object.keys(manifest.platforms).join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`::error::${err.message}`);
    process.exit(1);
  });
}
