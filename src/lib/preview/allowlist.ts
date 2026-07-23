const LOCALHOST_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0']);

function hostMatchesGlob(host: string, pattern: string): boolean {
  // Only supports a single leading '*.' — 'foo.*' or 'a*b' are literal.
  if (!pattern.startsWith('*.')) {
    return host === pattern;
  }
  const suffix = pattern.slice(1); // '.ngrok.io'
  // Must end with suffix AND the prefix must be exactly one dotless label.
  if (!host.endsWith(suffix)) return false;
  const prefix = host.slice(0, host.length - suffix.length);
  return prefix.length > 0 && !prefix.includes('.');
}

export function isUrlAllowed(rawUrl: string, allowList: string[]): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (LOCALHOST_HOSTS.has(url.hostname)) return true;
  return allowList.some((p) => hostMatchesGlob(url.hostname, p));
}
