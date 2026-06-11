import { describe, it, expect } from 'vitest';
import { diagnosticsToMarkers, type LspDiagnostic } from './markers';

const diag = (over: Partial<LspDiagnostic> = {}): LspDiagnostic => ({
  range: { start: { line: 4, character: 2 }, end: { line: 4, character: 9 } },
  message: "Cannot find name 'foo'.",
  severity: 1,
  source: 'ts',
  code: 2304,
  ...over,
});

describe('diagnosticsToMarkers', () => {
  it('converts 0-based LSP positions to 1-based Monaco positions', () => {
    const [m] = diagnosticsToMarkers([diag()]);
    expect(m.startLineNumber).toBe(5);
    expect(m.startColumn).toBe(3);
    expect(m.endLineNumber).toBe(5);
    expect(m.endColumn).toBe(10);
    expect(m.message).toBe("Cannot find name 'foo'.");
    expect(m.source).toBe('ts');
    expect(m.code).toBe('2304');
  });
  it('maps severities (LSP 1..4 → Monaco 8/4/2/1), default Warning', () => {
    expect(diagnosticsToMarkers([diag({ severity: 1 })])[0].severity).toBe(8);
    expect(diagnosticsToMarkers([diag({ severity: 2 })])[0].severity).toBe(4);
    expect(diagnosticsToMarkers([diag({ severity: 3 })])[0].severity).toBe(2);
    expect(diagnosticsToMarkers([diag({ severity: 4 })])[0].severity).toBe(1);
    expect(diagnosticsToMarkers([diag({ severity: undefined })])[0].severity).toBe(4);
  });
});
