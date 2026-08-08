// Palette source registry — types + fixed-order array for the command
// palette's Search Everywhere upgrade (Phase 5). This file only defines the
// shape; Task B populates PALETTE_SOURCES and rewrites CommandPalette to
// consume it.

import type { LucideIcon } from 'lucide-react';

/** A single result item in the command palette. */
export interface PaletteItem {
  id: string;
  /** Stable key for frecency tracking. Empty string = not tracked. */
  frecencyKey: string;
  label: string;
  description: string;
  category: string;
  icon?: LucideIcon;
  shortcut?: string;
  /** Tailwind bg-* class for a presence dot. Supplementary; status is also
   *  spelled out in the description so we never convey state by color alone. */
  statusColor?: string;
  action: () => void;
}

/**
 * A palette source contributes items to the command palette. Sources are
 * enumerated in a fixed order and can be filtered via the source-chip
 * strip or the prefix characters.
 */
export interface PaletteSource {
  /** Stable id used in filter state. */
  id: string;
  /** Human-readable label shown in the chip strip. */
  label: string;
  /** Icon for the chip. */
  icon: LucideIcon;
  /** Optional single-char prefix that filters to just this source (e.g. '>', '@', '#'). */
  prefix?: string;
  /** Category name items from this source use (must match PaletteItem.category). */
  category: string;
}

/**
 * Static registry of sources in the order they appear in the chip strip.
 * When a source is added, Task B (filter chips) auto-picks it up.
 */
export const PALETTE_SOURCES: PaletteSource[] = [];
