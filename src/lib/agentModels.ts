// Curated `--model` catalogs for the non-Claude agents the New Terminal
// modal exposes. Claude's catalog lives in `claudeModels.ts` (it has a
// two-tier family/variant picker); the agents here get a single chip row,
// so each list is a hand-picked subset of what the CLI actually accepts:
// - Codex:       https://learn.chatgpt.com/docs/models (`codex --model <id>`)
// - Cursor:      `agent --list-models` (~200 ids; we surface the headliners)
// - Antigravity: `agy models`
//
// Adding a model = one edit here. The modal picker and the tab-strip /
// status-bar badge lookups all read from these arrays.

import type { AgentKind, BuiltinAgentKind } from './agents';
import { isCustomAgent } from './agents';
import { CLAUDE_MODELS } from './claudeModels';

export interface AgentModel {
  /** Exact id passed to the CLI's `--model` flag. Also the persisted value. */
  alias: string;
  /** Short label shown on the picker chip and in the model badge. */
  label: string;
  /** Longer label for tooltips. */
  fullLabel: string;
  /** Badge tint (bg + text) for tab strip / status bar, same contract as
   *  ClaudeModel.badgeClasses. */
  badgeClasses: string;
  /** Ring the modal picker adds when the chip is selected. */
  ringClasses: string;
}

// Vendor tints, kept consistent across agents so the same underlying model
// family reads the same everywhere: OpenAI = teal, Cursor-native = orange,
// Gemini = sky, Claude Sonnet = blue, Claude Opus = purple (matching
// claudeModels.ts).
const OPENAI = { badgeClasses: 'bg-teal-500/20 text-teal-400', ringClasses: 'ring-1 ring-teal-500/30' };
const CURSOR = { badgeClasses: 'bg-orange-500/20 text-orange-400', ringClasses: 'ring-1 ring-orange-500/30' };
const GEMINI = { badgeClasses: 'bg-sky-500/20 text-sky-400', ringClasses: 'ring-1 ring-sky-500/30' };
const SONNET = { badgeClasses: 'bg-blue-500/20 text-blue-400', ringClasses: 'ring-1 ring-blue-500/30' };
const OPUS = { badgeClasses: 'bg-purple-500/20 text-purple-400', ringClasses: 'ring-1 ring-purple-500/30' };

export const AGENT_MODELS: Record<Exclude<BuiltinAgentKind, 'claude'>, readonly AgentModel[]> = {
  codex: [
    { alias: 'gpt-5.6-sol', label: 'Sol', fullLabel: 'GPT-5.6 Sol - flagship', ...OPENAI },
    { alias: 'gpt-5.6-terra', label: 'Terra', fullLabel: 'GPT-5.6 Terra - everyday workhorse', ...OPENAI },
    { alias: 'gpt-5.6-luna', label: 'Luna', fullLabel: 'GPT-5.6 Luna - fast and affordable', ...OPENAI },
    { alias: 'gpt-5.5', label: 'GPT-5.5', fullLabel: 'GPT-5.5 - previous-generation flagship', ...OPENAI },
  ],
  cursor: [
    { alias: 'auto', label: 'Auto', fullLabel: 'Auto - Cursor picks the model', ...CURSOR },
    { alias: 'composer-2.5', label: 'Composer 2.5', fullLabel: 'Composer 2.5 - Cursor in-house', ...CURSOR },
    { alias: 'gpt-5.3-codex', label: 'Codex 5.3', fullLabel: 'GPT-5.3 Codex', ...OPENAI },
    { alias: 'gpt-5.6-sol-high', label: 'GPT-5.6 Sol', fullLabel: 'GPT-5.6 Sol 1M High', ...OPENAI },
    { alias: 'claude-sonnet-5-thinking-high', label: 'Sonnet 5', fullLabel: 'Claude Sonnet 5 1M Thinking', ...SONNET },
    { alias: 'claude-opus-5-thinking-high', label: 'Opus 5', fullLabel: 'Claude Opus 5 1M Thinking', ...OPUS },
    { alias: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', fullLabel: 'Gemini 3.1 Pro', ...GEMINI },
  ],
  antigravity: [
    { alias: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash', fullLabel: 'Gemini 3.7 Flash (High)', ...GEMINI },
    { alias: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro', fullLabel: 'Gemini 3.1 Pro (High)', ...GEMINI },
    { alias: 'claude-sonnet-4-6', label: 'Sonnet 4.6', fullLabel: 'Claude Sonnet 4.6 (Thinking)', ...SONNET },
    { alias: 'claude-opus-4-6-thinking', label: 'Opus 4.6', fullLabel: 'Claude Opus 4.6 (Thinking)', ...OPUS },
    { alias: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B', fullLabel: 'GPT-OSS 120B (Medium)', ...OPENAI },
  ],
};

/**
 * Models the picker offers for an agent. Claude returns an empty list -
 * its picker is driven by `claudeModels.ts`, not this catalog.
 */
export function modelsForAgent(kind: AgentKind): readonly AgentModel[] {
  if (kind === 'claude' || isCustomAgent(kind)) return [];
  return AGENT_MODELS[kind];
}

// Flat alias -> model lookup across every agent catalog. Aliases don't
// collide across agents today; if two agents ever share an alias with
// different tints, first-in wins (they'd be the same vendor anyway).
const ALL_AGENT_MODELS = new Map<string, AgentModel>();
for (const list of Object.values(AGENT_MODELS)) {
  for (const m of list) {
    if (!ALL_AGENT_MODELS.has(m.alias)) ALL_AGENT_MODELS.set(m.alias, m);
  }
}

/**
 * Badge classes for a model alias from ANY agent's catalog (Claude aliases
 * included). Used by the tab strip and status bar, which only know the
 * alias string parsed out of the spawn args. Unknown aliases get a muted
 * style so a hand-typed or since-removed model still renders.
 */
export function getAnyModelBadgeClasses(alias: string | undefined): string {
  if (!alias) return 'bg-fill-hover text-text-tertiary';
  const claude = CLAUDE_MODELS.find(m => m.alias === alias);
  if (claude) return claude.badgeClasses;
  return ALL_AGENT_MODELS.get(alias)?.badgeClasses ?? 'bg-fill-hover text-text-tertiary';
}

/**
 * Short display text for a model badge. Long agent ids (e.g.
 * `claude-opus-5-thinking-high`) would blow the tab strip's width budget,
 * so known aliases render their catalog label; unknown ones fall back to
 * the raw alias. Claude aliases are already short - they render as-is.
 */
export function getModelBadgeLabel(alias: string): string {
  return ALL_AGENT_MODELS.get(alias)?.label ?? alias;
}
