import { describe, expect, it } from 'vitest';
import { pickBreadcrumb } from './breadcrumb';

describe('pickBreadcrumb', () => {
  it('returns the "No sessions" placeholder when path is undefined', () => {
    expect(pickBreadcrumb(undefined)).toEqual({ project: 'No sessions', sub: null });
  });

  it('returns the "No sessions" placeholder for an empty string (falsy)', () => {
    // Empty string is falsy and takes the same early-return branch as undefined.
    expect(pickBreadcrumb('')).toEqual({ project: 'No sessions', sub: null });
  });

  it('parses a Windows path into project + parent segments', () => {
    expect(pickBreadcrumb('C:\\Users\\me\\project')).toEqual({
      project: 'project',
      sub: 'me',
    });
  });

  it('parses a POSIX path into project + parent segments', () => {
    expect(pickBreadcrumb('/home/user/repo')).toEqual({
      project: 'repo',
      sub: 'user',
    });
  });

  it('ignores a trailing separator', () => {
    expect(pickBreadcrumb('C:\\Users\\me\\project\\')).toEqual({
      project: 'project',
      sub: 'me',
    });
  });

  it('ignores a trailing POSIX separator', () => {
    expect(pickBreadcrumb('/home/user/repo/')).toEqual({
      project: 'repo',
      sub: 'user',
    });
  });

  it('returns just the project when the path has a single segment', () => {
    expect(pickBreadcrumb('root')).toEqual({ project: 'root', sub: null });
  });

  it('returns the root marker when the path is just a separator', () => {
    // '/' normalises + trims to '' → parts is empty → clean falls back to '/'.
    expect(pickBreadcrumb('/')).toEqual({ project: '/', sub: null });
  });

  it('handles mixed-separator paths', () => {
    expect(pickBreadcrumb('C:/Users\\me/project')).toEqual({
      project: 'project',
      sub: 'me',
    });
  });
});
