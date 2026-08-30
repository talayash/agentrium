/**
 * Parse a working-directory path into an IntelliJ-style project breadcrumb.
 *
 * The last path segment becomes the primary `project` label; the segment before
 * it becomes the dimmed parent `sub` label (`null` when there is only one
 * segment or no meaningful path).
 *
 * Handles both Windows (`\`) and POSIX (`/`) separators, and trims any trailing
 * separator characters before splitting.
 */
export function pickBreadcrumb(
  path: string | undefined
): { project: string; sub: string | null } {
  if (!path) return { project: 'No sessions', sub: null };
  // Normalise slashes and trim trailing separators
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = clean.split('/').filter(Boolean);
  if (parts.length === 0) return { project: clean || '/', sub: null };
  if (parts.length === 1) return { project: parts[0], sub: null };
  const project = parts[parts.length - 1];
  const parent = parts[parts.length - 2];
  return { project, sub: parent };
}
