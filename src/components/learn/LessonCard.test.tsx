import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LessonCardView } from './LessonCard';
import type { LessonCard } from '../../lib/learn';

afterEach(cleanup);

const card: LessonCard = {
  id: 'a', terminalId: 't1', createdAt: '', kind: 'pattern', title: 'Decorator: wrap a function',
  filePath: 'src/lib/api.ts', startLine: 42, endLine: 43, quote: ['export function withRetry<T>(', '  fn: () => Promise<T>,'],
  highlight: [42], why: ['simple why', 'middle why', 'expert why'], question: 'What does withRetry return?',
  options: ['The data', 'A new function', 'A Promise'], answerIndex: 1, explain: 'Line 45 returns a function.',
  saved: false, answeredIndex: null,
};

const noop = () => {};

it('shows the quoted code with real line numbers and the level text', () => {
  render(<LessonCardView card={card} level={1} onPick={noop} onToggleSave={noop} onLevel={noop} onNext={noop} />);
  expect(screen.getByText('src/lib/api.ts:42-43')).toBeTruthy();
  expect(screen.getByText('42')).toBeTruthy();
  expect(screen.getByText('middle why')).toBeTruthy();
  expect(screen.getByText('Pick an answer to reveal why.')).toBeTruthy();
});

it('reports a pick and level changes', () => {
  const onPick = vi.fn();
  const onLevel = vi.fn();
  render(<LessonCardView card={card} level={1} onPick={onPick} onToggleSave={noop} onLevel={onLevel} onNext={noop} />);
  fireEvent.click(screen.getByRole('button', { name: 'A new function' }));
  expect(onPick).toHaveBeenCalledWith(1);
  fireEvent.click(screen.getByRole('button', { name: 'Explain simpler' }));
  expect(onLevel).toHaveBeenCalledWith(0);
  fireEvent.click(screen.getByRole('button', { name: 'Go deeper' }));
  expect(onLevel).toHaveBeenCalledWith(2);
});

it('reveals the verdict and locks options once answered', () => {
  render(<LessonCardView card={{ ...card, answeredIndex: 0 }} level={1} onPick={noop} onToggleSave={noop} onLevel={noop} onNext={noop} />);
  expect(screen.getByText(/Not quite\./)).toBeTruthy();
  expect(screen.getByText(/Line 45 returns a function\./)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'A Promise' }) as HTMLButtonElement).disabled).toBe(true);
});

it('disables level buttons at the ends and shows saved state', () => {
  render(<LessonCardView card={{ ...card, saved: true }} level={0} onPick={noop} onToggleSave={noop} onLevel={noop} onNext={noop} />);
  expect((screen.getByRole('button', { name: 'Explain simpler' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Saved' }).getAttribute('aria-pressed')).toBe('true');
});
