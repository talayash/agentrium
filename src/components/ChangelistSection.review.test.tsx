import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
const stageForAgent = vi.fn();
vi.mock('../lib/agentContext', () => ({ stageForAgent: (...a: unknown[]) => stageForAgent(...a) }));

import { ChangelistSection } from './ChangelistSection';
import { useReviewStore, commentsFor } from '../store/reviewStore';
import { buildReviewBrief } from '../lib/review';

const mk = (terminalId: string, body: string) => ({ terminalId, filePath: 'a.ts', side: 'new' as const, line: 1, snippet: 's', body });

function renderSection() {
  return render(
    <ChangelistSection
      repoPath="C:\repo" files={[]} branch="main" onStage={() => {}} onUnstage={() => {}}
      stagingPaths={new Set()} refreshTrigger={0} expandedFile={null} setExpandedFile={() => {}}
      terminalId="t1" pathOverride={null}
    />,
  );
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  stageForAgent.mockReset();
  useReviewStore.setState({ comments: [] });
  useReviewStore.getState().add(mk('t1', 'one'));
  useReviewStore.getState().add(mk('t2', 'other'));
});
afterEach(() => cleanup());

describe('ChangelistSection send bar', () => {
  it('Send stages the built brief and clears only this terminal', () => {
    const expected = buildReviewBrief(commentsFor('t1'));
    renderSection();
    fireEvent.click(screen.getByText('Send review (1)'));
    expect(stageForAgent).toHaveBeenCalledWith('t1', expected);
    expect(commentsFor('t1')).toHaveLength(0);
    expect(commentsFor('t2')).toHaveLength(1);
  });

  it('Discard clears without staging', () => {
    renderSection();
    fireEvent.click(screen.getByText('Discard'));
    expect(stageForAgent).not.toHaveBeenCalled();
    expect(commentsFor('t1')).toHaveLength(0);
  });
});
