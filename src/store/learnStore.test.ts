import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { useLearnStore } from './learnStore';
import { reportInvokeFailure } from '../lib/errorReporter';
import type { LessonCard } from '../lib/learn';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../lib/errorReporter', () => ({ reportInvokeFailure: vi.fn() }));

const card = (id: string, extra: Partial<LessonCard> = {}): LessonCard => ({
  id, terminalId: 't1', createdAt: '2026-10-12T10:00:00Z', kind: 'pattern', title: `Card ${id}`,
  filePath: 'src/a.ts', startLine: 1, endLine: 2, quote: ['a', 'b'], highlight: [1],
  why: ['b', 'i', 'e'], question: 'q?', options: ['x', 'y', 'z'], answerIndex: 1, explain: 'because',
  saved: false, answeredIndex: null, ...extra,
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(reportInvokeFailure).mockReset();
  useLearnStore.setState({ byTerminal: {} });
});

it('generate ok reloads the list and marks new cards unseen', async () => {
  vi.mocked(invoke).mockImplementation(async (cmd) => {
    if (cmd === 'generate_learn_cards') return { status: 'ok', cards: [card('a'), card('b')] } as never;
    if (cmd === 'list_learn_cards') return [card('a'), card('b'), card('old', { saved: true })] as never;
    return undefined as never;
  });
  const res = await useLearnStore.getState().generate('t1', { goal: 'add retry' });
  expect(invoke).toHaveBeenCalledWith('generate_learn_cards', { terminalId: 't1', goal: 'add retry' });
  expect(res?.status).toBe('ok');
  const entry = useLearnStore.getState().byTerminal.t1;
  expect(entry.status).toBe('ok');
  expect(entry.cards.map((c) => c.id)).toEqual(['a', 'b', 'old']);
  expect(entry.unseen).toBe(2);
});

it('keeps non-ok statuses as data without reporting', async () => {
  vi.mocked(invoke).mockResolvedValue({ status: 'no_consent', cards: [] } as never);
  await useLearnStore.getState().generate('t1');
  expect(useLearnStore.getState().byTerminal.t1.status).toBe('no_consent');
  expect(reportInvokeFailure).not.toHaveBeenCalled();
});

it('reports a thrown manual generate but stays quiet when silent', async () => {
  vi.mocked(invoke).mockRejectedValue(new Error('boom'));
  await useLearnStore.getState().generate('t1');
  expect(useLearnStore.getState().byTerminal.t1.status).toBe('failed');
  expect(reportInvokeFailure).toHaveBeenCalledWith('generate_learn_cards', expect.anything());
  vi.mocked(reportInvokeFailure).mockReset();
  await useLearnStore.getState().generate('t2', { silent: true });
  expect(reportInvokeFailure).not.toHaveBeenCalled();
});

it('answer and toggleSave update optimistically and persist', async () => {
  useLearnStore.setState({ byTerminal: { t1: { status: 'ok', cards: [card('a')], unseen: 1 } } });
  vi.mocked(invoke).mockResolvedValue(undefined as never);
  await useLearnStore.getState().answer('t1', 'a', 2);
  expect(useLearnStore.getState().byTerminal.t1.cards[0].answeredIndex).toBe(2);
  expect(invoke).toHaveBeenCalledWith('update_learn_card', { id: 'a', saved: null, answeredIndex: 2 });
  await useLearnStore.getState().toggleSave('t1', 'a');
  expect(useLearnStore.getState().byTerminal.t1.cards[0].saved).toBe(true);
  expect(invoke).toHaveBeenCalledWith('update_learn_card', { id: 'a', saved: true, answeredIndex: null });
});

it('reverts a failed save', async () => {
  useLearnStore.setState({ byTerminal: { t1: { status: 'ok', cards: [card('a')], unseen: 0 } } });
  vi.mocked(invoke).mockRejectedValue(new Error('disk'));
  await useLearnStore.getState().toggleSave('t1', 'a');
  expect(useLearnStore.getState().byTerminal.t1.cards[0].saved).toBe(false);
  expect(reportInvokeFailure).toHaveBeenCalledWith('update_learn_card', expect.anything());
});

it('keeps loading when another run is in progress', async () => {
  vi.mocked(invoke).mockResolvedValue({ status: 'in_progress', cards: [] } as never);
  await useLearnStore.getState().generate('t1');
  expect(useLearnStore.getState().byTerminal.t1.status).toBe('loading');
});

it('onCardsUpdated reloads cards and bumps unseen only when notify is set', async () => {
  vi.mocked(invoke).mockResolvedValue([card('a'), card('b')] as never);
  await useLearnStore.getState().onCardsUpdated('t1');
  expect(invoke).toHaveBeenCalledWith('list_learn_cards', { terminalId: 't1' });
  expect(useLearnStore.getState().byTerminal.t1.cards).toHaveLength(2);
  expect(useLearnStore.getState().byTerminal.t1.unseen).toBe(0);
  await useLearnStore.getState().onCardsUpdated('t1', { count: 2, notify: true });
  expect(useLearnStore.getState().byTerminal.t1.unseen).toBe(2);
});
