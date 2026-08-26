import type React from 'react';

/**
 * Flex sizing for the stacked Sessions / Explorer sections of the sidebar.
 *
 * Layout rules (kept in sync with the comment in `Sidebar.tsx`):
 * - A collapsed section auto-sizes to just its header (`flex: '0 0 auto'`).
 * - When both are expanded, they share the vertical space by
 *   `sessionsHeightRatio` (Sessions) / `1 - sessionsHeightRatio` (Explorer),
 *   each with a `minHeight: 80` so neither can be squeezed away.
 * - When exactly one is expanded, that section takes all remaining space
 *   (`flex: '1 1 0'`).
 *
 * The caller is responsible for resolving "expanded" - e.g. Explorer is only
 * considered expanded when `!explorerCollapsed && showFileTree`. That store
 * lookup stays in the component; this helper takes plain booleans.
 */
export interface SidebarSectionStyles {
  sessionsStyle: React.CSSProperties;
  explorerStyle: React.CSSProperties;
}

export function computeSidebarSectionStyles(params: {
  sessionsExpanded: boolean;
  explorerExpanded: boolean;
  sessionsHeightRatio: number;
}): SidebarSectionStyles {
  const bothExpanded = params.sessionsExpanded && params.explorerExpanded;
  const sessionsStyle: React.CSSProperties = !params.sessionsExpanded
    ? { flex: '0 0 auto' }
    : bothExpanded
    ? { flex: `${params.sessionsHeightRatio} 1 0`, minHeight: 80 }
    : { flex: '1 1 0' };
  const explorerStyle: React.CSSProperties = !params.explorerExpanded
    ? { flex: '0 0 auto' }
    : bothExpanded
    ? { flex: `${1 - params.sessionsHeightRatio} 1 0`, minHeight: 80 }
    : { flex: '1 1 0' };
  return { sessionsStyle, explorerStyle };
}
