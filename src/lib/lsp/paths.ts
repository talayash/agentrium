// Path/URI bridging between Monaco models (raw fs paths) and LSP (file URIs).
// Different servers emit different encodings (`c%3A` vs `C:`), so all
// comparisons go through pathKey().

export function pathToFileUri(p: string): string {
  let n = p.replace(/\\/g, '/');
  if (!n.startsWith('/')) n = '/' + n;
  // encodeURI leaves ':' and '/' intact; '#' would terminate the path.
  return 'file://' + encodeURI(n).replace(/#/g, '%23');
}

/** Canonical lowercase forward-slash form for matching paths and file URIs. */
export function pathKey(uriOrPath: string): string {
  let s = uriOrPath;
  if (s.startsWith('file://')) {
    s = decodeURIComponent(s.slice('file://'.length));
  }
  s = s.replace(/\\/g, '/');
  if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1); // /C:/... → C:/...
  return s.toLowerCase();
}
