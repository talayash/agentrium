// Address-bar input -> URL. Typed text is either an address (scheme added
// when missing) or a search query. The Rust side re-validates every URL, so
// a non-web scheme is passed through and rejected there with a clear message.

export const SEARCH_URL = 'https://www.google.com/search?q=';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#].*)?$/i;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?([/?#].*)?$/;
// host.tld, optional port and path. TLD must be letters so "1.5" stays a search.
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#].*)?$/i;

export function resolveAddress(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  if (/\s/.test(text)) return SEARCH_URL + encodeURIComponent(text);

  // "localhost:3000" also matches SCHEME ("localhost:"), so check hosts first.
  if (LOCAL_HOST.test(text) || IPV4.test(text)) return `http://${text}`;
  if (DOMAIN.test(text)) return `https://${text}`;
  if (SCHEME.test(text)) return text;
  return SEARCH_URL + encodeURIComponent(text);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

export function isSecure(url: string): boolean {
  return url.startsWith('https://');
}
