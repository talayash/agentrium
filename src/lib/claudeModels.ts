// Central catalog for the Claude Code `--model` aliases that the New Terminal
// modal and Settings > Claude Defaults expose. Keep this in sync with the
// aliases `claude --model <x>` accepts (verify with `claude --help`; the CLI
// only documents examples, so we track the set the UI has decided to surface).
//
// Adding a new model = one edit here. The modal picker, defaults dropdown,
// status-bar badge, and tab-strip badge all read from this array.

export type ClaudeModelFamily = 'default' | 'fable' | 'opus' | 'sonnet' | 'haiku';

export interface ClaudeModel {
  /** CLI alias passed to `claude --model <alias>`. Also the persisted value. */
  alias: string;
  /** Short label shown on the picker button / dropdown option. */
  label: string;
  /** Longer label used in Settings dropdown (family included for clarity). */
  fullLabel: string;
  family: ClaudeModelFamily;
  /**
   * Concrete upstream version this alias currently resolves to (e.g. "4.7").
   * Display-only - the CLI still receives the family alias verbatim. Absent
   * for families with no fixed version (Default, Fable). Bump this alongside
   * the model on each Anthropic release; see issue #65.
   */
  resolvedVersion?: string;
  /**
   * Tailwind background+text classes for the model badge as it appears in
   * the tab strip / status bar (bg tint + colored text, no ring). The
   * modal picker adds its own ring on top of these classes when a chip
   * is selected.
   */
  badgeClasses: string;
  /**
   * Tailwind ring class the modal picker uses when this model's chip is
   * selected. Separate from `badgeClasses` because the status-bar/tab
   * badges intentionally have no ring - adding one would visually
   * regress the calm look of those chrome elements.
   */
  ringClasses: string;
}

// Family-first ordering. Within a family, base alias then variants.
export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  {
    alias: 'default',
    label: 'Default',
    fullLabel: 'Default',
    family: 'default',
    badgeClasses: 'bg-accent-primary/10 text-accent-primary',
    ringClasses: 'ring-1 ring-accent-primary/30',
  },
  {
    alias: 'fable',
    label: 'Fable',
    fullLabel: 'Fable',
    family: 'fable',
    badgeClasses: 'bg-amber-500/20 text-amber-400',
    ringClasses: 'ring-1 ring-amber-500/30',
  },
  {
    alias: 'opus',
    label: 'Opus 4.7',
    fullLabel: 'Opus 4.7',
    family: 'opus',
    resolvedVersion: '4.7',
    badgeClasses: 'bg-purple-500/20 text-purple-400',
    ringClasses: 'ring-1 ring-purple-500/30',
  },
  {
    alias: 'opus[1m]',
    label: '1M context',
    fullLabel: 'Opus 4.7 · 1M context',
    family: 'opus',
    resolvedVersion: '4.7',
    badgeClasses: 'bg-purple-500/20 text-purple-400',
    ringClasses: 'ring-1 ring-purple-500/30',
  },
  {
    alias: 'opusplan',
    label: 'Plan',
    fullLabel: 'Opus 4.7 · Plan',
    family: 'opus',
    resolvedVersion: '4.7',
    badgeClasses: 'bg-purple-500/20 text-purple-400',
    ringClasses: 'ring-1 ring-purple-500/30',
  },
  {
    alias: 'sonnet',
    label: 'Sonnet 4.6',
    fullLabel: 'Sonnet 4.6',
    family: 'sonnet',
    resolvedVersion: '4.6',
    badgeClasses: 'bg-blue-500/20 text-blue-400',
    ringClasses: 'ring-1 ring-blue-500/30',
  },
  {
    alias: 'sonnet[1m]',
    label: '1M context',
    fullLabel: 'Sonnet 4.6 · 1M context',
    family: 'sonnet',
    resolvedVersion: '4.6',
    badgeClasses: 'bg-blue-500/20 text-blue-400',
    ringClasses: 'ring-1 ring-blue-500/30',
  },
  {
    alias: 'haiku',
    label: 'Haiku 4.5',
    fullLabel: 'Haiku 4.5',
    family: 'haiku',
    resolvedVersion: '4.5',
    badgeClasses: 'bg-green-500/20 text-green-400',
    ringClasses: 'ring-1 ring-green-500/30',
  },
];

// Aliases as a Set for O(1) membership checks in validators.
const ALIAS_SET = new Set(CLAUDE_MODELS.map(m => m.alias));

export function isClaudeModelAlias(x: string): boolean {
  return ALIAS_SET.has(x);
}

// Family order for the top-row picker. `default` stays first, then families
// in the order the user is most likely to reach for (Fable is the newest
// headline model).
export const CLAUDE_MODEL_FAMILIES: readonly ClaudeModelFamily[] = [
  'default', 'fable', 'opus', 'sonnet', 'haiku',
];

export function modelsInFamily(family: ClaudeModelFamily): ClaudeModel[] {
  return CLAUDE_MODELS.filter(m => m.family === family);
}

export function familyLabel(family: ClaudeModelFamily): string {
  // Return the base entry's label as-is so version suffixes ("Opus 4.7")
  // surface on the top-row family chip. The base entry per family is the
  // one without a variant qualifier (opus, sonnet, haiku, fable, default).
  const first = CLAUDE_MODELS.find(m => m.family === family);
  return first ? first.label : family;
}

/**
 * Badge classes for a model alias as it appears in the terminal tab strip
 * and status bar. Falls back to a muted style for unknown aliases so a
 * removed-then-persisted model still renders instead of crashing.
 */
export function getModelBadgeClasses(alias: string | undefined): string {
  if (!alias) return 'bg-fill-hover text-text-tertiary';
  const m = CLAUDE_MODELS.find(x => x.alias === alias);
  return m ? m.badgeClasses : 'bg-fill-hover text-text-tertiary';
}

/**
 * Which family a persisted model alias belongs to. Used to hydrate the
 * two-tier picker's family selection from a persisted default. Unknown
 * aliases fall back to 'default'.
 */
export function familyOfModel(alias: string | undefined): ClaudeModelFamily {
  if (!alias) return 'default';
  const m = CLAUDE_MODELS.find(x => x.alias === alias);
  return m ? m.family : 'default';
}
