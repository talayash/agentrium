export type LearnKind = 'pattern' | 'system_design' | 'syntax' | 'concept';
export type LearnLevel = 0 | 1 | 2;

export interface LessonCard {
  id: string;
  terminalId: string;
  createdAt: string;
  kind: LearnKind;
  title: string;
  filePath: string;
  startLine: number;
  endLine: number;
  quote: string[];
  highlight: number[];
  why: [string, string, string];
  question: string;
  options: [string, string, string];
  answerIndex: number;
  explain: string;
  saved: boolean;
  answeredIndex: number | null;
}

export type GenerateStatus =
  | 'ok' | 'no_consent' | 'no_changes' | 'no_cards' | 'in_progress' | 'cli_missing' | 'timeout' | 'failed';

export interface GenerateResult {
  status: GenerateStatus;
  cards: LessonCard[];
}

export const KIND_LABEL: Record<LearnKind, string> = {
  pattern: 'Design pattern',
  system_design: 'System design',
  syntax: 'Syntax',
  concept: 'Concept',
};

export const KIND_SHORT: Record<LearnKind, string> = {
  pattern: 'Pattern',
  system_design: 'System design',
  syntax: 'Syntax',
  concept: 'Concept',
};

export const LEVEL_LABELS = ['Beginner', 'Intermediate', 'Expert'] as const;

export const STATUS_MESSAGE: Record<Exclude<GenerateStatus, 'ok'>, string> = {
  no_consent: 'Allow Learn to read this change to get lessons.',
  no_changes: 'No changes to learn from yet. Run an agent, then try again.',
  no_cards: 'Nothing in this change was worth a lesson.',
  in_progress: 'Lessons are already being written for this session.',
  cli_missing: 'Learn needs Claude Code installed.',
  timeout: 'Claude took too long. Try again.',
  failed: 'Could not write lessons for this change. Try again.',
};
