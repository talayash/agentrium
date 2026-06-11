// LSP Diagnostic → monaco.editor.IMarkerData. Pure data conversion: no
// monaco import so it stays unit-testable. Numeric severity values are
// monaco's MarkerSeverity enum (Hint=1, Info=2, Warning=4, Error=8).

export interface LspDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  message: string;
  severity?: number; // LSP: 1=Error 2=Warning 3=Info 4=Hint
  source?: string;
  code?: string | number;
}

export interface MarkerData {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
  severity: number;
  source?: string;
  code?: string;
}

const SEVERITY_LSP_TO_MONACO: Record<number, number> = { 1: 8, 2: 4, 3: 2, 4: 1 };

export function diagnosticsToMarkers(diags: LspDiagnostic[]): MarkerData[] {
  return diags.map((d) => ({
    startLineNumber: d.range.start.line + 1,
    startColumn: d.range.start.character + 1,
    endLineNumber: d.range.end.line + 1,
    endColumn: d.range.end.character + 1,
    message: d.message,
    severity: SEVERITY_LSP_TO_MONACO[d.severity ?? 2] ?? 4,
    source: d.source,
    code: d.code !== undefined ? String(d.code) : undefined,
  }));
}
