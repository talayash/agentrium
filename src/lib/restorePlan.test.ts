import { describe, it, expect } from 'vitest';
import { planRestoreModes } from './restorePlan';

describe('planRestoreModes', () => {
  it('resumes distinct session ids as-is', () => {
    const modes = planRestoreModes([
      { claude_session_id: 'aaa', working_directory: 'C:\\proj' },
      { claude_session_id: 'bbb', working_directory: 'C:\\proj' },
    ]);
    expect(modes).toEqual([
      { kind: 'resume', sessionId: 'aaa' },
      { kind: 'resume', sessionId: 'bbb' },
    ]);
  });

  it('never resumes the same session id twice (the paste-appears-in-all-tabs bug)', () => {
    const modes = planRestoreModes([
      { claude_session_id: 'shared', working_directory: 'C:\\proj' },
      { claude_session_id: 'shared', working_directory: 'C:\\proj' },
      { claude_session_id: 'shared', working_directory: 'C:\\proj' },
    ]);
    expect(modes[0]).toEqual({ kind: 'resume', sessionId: 'shared' });
    expect(modes[1]).toEqual({ kind: 'fresh' });
    expect(modes[2]).toEqual({ kind: 'fresh' });
  });

  it('allows only one --continue per working directory', () => {
    const modes = planRestoreModes([
      { claude_session_id: null, working_directory: 'C:\\proj' },
      { claude_session_id: null, working_directory: 'C:\\proj' },
      { claude_session_id: null, working_directory: 'C:\\other' },
    ]);
    expect(modes).toEqual([
      { kind: 'continue' },
      { kind: 'fresh' },
      { kind: 'continue' },
    ]);
  });

  it('treats cwds case-insensitively', () => {
    const modes = planRestoreModes([
      { claude_session_id: null, working_directory: 'C:\\Proj' },
      { claude_session_id: undefined, working_directory: 'c:\\proj' },
    ]);
    expect(modes).toEqual([{ kind: 'continue' }, { kind: 'fresh' }]);
  });

  it('shell/script sentinels never consume the --continue slot for their cwd', () => {
    const modes = planRestoreModes([
      { claude_session_id: null, working_directory: 'C:\\proj', claude_args: ['__shell__'] },
      { claude_session_id: null, working_directory: 'C:\\proj', claude_args: [] },
      { claude_session_id: null, working_directory: 'C:\\proj', claude_args: ['__script__', 'dev'] },
    ]);
    expect(modes).toEqual([
      { kind: 'fresh' },
      { kind: 'continue' },
      { kind: 'fresh' },
    ]);
  });

  it('mixes id and id-less terminals independently', () => {
    const modes = planRestoreModes([
      { claude_session_id: 'aaa', working_directory: 'C:\\proj' },
      { claude_session_id: null, working_directory: 'C:\\proj' },
      { claude_session_id: 'aaa', working_directory: 'C:\\proj' },
      { claude_session_id: null, working_directory: 'C:\\proj' },
    ]);
    expect(modes).toEqual([
      { kind: 'resume', sessionId: 'aaa' },
      { kind: 'continue' },
      { kind: 'fresh' },
      { kind: 'fresh' },
    ]);
  });
});
