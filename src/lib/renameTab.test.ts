import { describe, expect, it } from 'vitest';
import { resolveRenameCommit } from './renameTab';

describe('resolveRenameCommit', () => {
  it('no-op when the trimmed input equals the current nickname', () => {
    expect(resolveRenameCommit({ currentNickname: 'Custom', raw: 'Custom' })).toEqual({
      shouldCommit: false,
      nickname: '',
    });
  });

  it('no-op when leading/trailing whitespace makes the input equal the current nickname', () => {
    // The input reflects what the user typed, but a stray space shouldn't
    // force a redundant IPC round-trip.
    expect(resolveRenameCommit({ currentNickname: 'Custom', raw: '  Custom  ' })).toEqual({
      shouldCommit: false,
      nickname: '',
    });
  });

  it('no-op when the terminal has no nickname and the user submits an empty input', () => {
    // Clearing something already cleared shouldn't send `update_terminal_nickname("")`.
    expect(resolveRenameCommit({ currentNickname: null, raw: '' })).toEqual({
      shouldCommit: false,
      nickname: '',
    });
    expect(resolveRenameCommit({ currentNickname: null, raw: '   ' })).toEqual({
      shouldCommit: false,
      nickname: '',
    });
  });

  it('commits an empty string when clearing an existing nickname', () => {
    // Persisting "" is how the backend signals "fall back to the profile label"
    // for the sidebar name (`name = nickname || label`).
    expect(resolveRenameCommit({ currentNickname: 'Custom', raw: '' })).toEqual({
      shouldCommit: true,
      nickname: '',
    });
  });

  it('commits the trimmed value when the user typed a new name', () => {
    expect(resolveRenameCommit({ currentNickname: null, raw: 'Renamed' })).toEqual({
      shouldCommit: true,
      nickname: 'Renamed',
    });
    expect(resolveRenameCommit({ currentNickname: 'Old', raw: '  New  ' })).toEqual({
      shouldCommit: true,
      nickname: 'New',
    });
  });
});
