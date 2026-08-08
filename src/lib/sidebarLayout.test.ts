import { describe, expect, it } from 'vitest';
import { computeSidebarSectionStyles } from './sidebarLayout';

describe('computeSidebarSectionStyles', () => {
  it('splits space by ratio when both sections are expanded (ratio 0.5)', () => {
    const { sessionsStyle, explorerStyle } = computeSidebarSectionStyles({
      sessionsExpanded: true,
      explorerExpanded: true,
      sessionsHeightRatio: 0.5,
    });
    expect(sessionsStyle).toEqual({ flex: '0.5 1 0', minHeight: 80 });
    expect(explorerStyle).toEqual({ flex: '0.5 1 0', minHeight: 80 });
  });

  it('splits space by ratio when both sections are expanded (ratio 0.7)', () => {
    const { sessionsStyle, explorerStyle } = computeSidebarSectionStyles({
      sessionsExpanded: true,
      explorerExpanded: true,
      sessionsHeightRatio: 0.7,
    });
    // Sessions gets exactly 0.7; Explorer gets `1 - 0.7`, which in IEEE 754
    // is 0.30000000000000004. We assert the raw string to guard against
    // accidental rounding creeping into the helper.
    expect(sessionsStyle).toEqual({ flex: '0.7 1 0', minHeight: 80 });
    expect(explorerStyle).toEqual({
      flex: `${1 - 0.7} 1 0`,
      minHeight: 80,
    });
  });

  it('gives all space to Explorer when Sessions is collapsed', () => {
    const { sessionsStyle, explorerStyle } = computeSidebarSectionStyles({
      sessionsExpanded: false,
      explorerExpanded: true,
      sessionsHeightRatio: 0.5,
    });
    expect(sessionsStyle).toEqual({ flex: '0 0 auto' });
    expect(explorerStyle).toEqual({ flex: '1 1 0' });
  });

  it('gives all space to Sessions when Explorer is collapsed', () => {
    const { sessionsStyle, explorerStyle } = computeSidebarSectionStyles({
      sessionsExpanded: true,
      explorerExpanded: false,
      sessionsHeightRatio: 0.5,
    });
    expect(sessionsStyle).toEqual({ flex: '1 1 0' });
    expect(explorerStyle).toEqual({ flex: '0 0 auto' });
  });

  it('auto-sizes both sections when both are collapsed', () => {
    const { sessionsStyle, explorerStyle } = computeSidebarSectionStyles({
      sessionsExpanded: false,
      explorerExpanded: false,
      sessionsHeightRatio: 0.5,
    });
    expect(sessionsStyle).toEqual({ flex: '0 0 auto' });
    expect(explorerStyle).toEqual({ flex: '0 0 auto' });
  });
});
