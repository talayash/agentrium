function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Label for a new session tab. The first session of a profile gets the bare
 * name ("New Admin"); only when one with that name is already open does it
 * get an index ("New Admin 2", "New Admin 3", ...), one past the highest in use.
 */
export function nextSessionLabel(baseName: string, existingLabels: Iterable<string>): string {
  const pattern = new RegExp(`^${escapeRegExp(baseName)}(?: (\\d+))?$`);
  let highest = 0;
  for (const label of existingLabels) {
    const m = pattern.exec(label);
    if (!m) continue;
    highest = Math.max(highest, m[1] ? Number(m[1]) : 1);
  }
  return highest === 0 ? baseName : `${baseName} ${highest + 1}`;
}
