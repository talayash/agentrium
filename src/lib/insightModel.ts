// Pure model: folds insight records (from the Rust tailer) into per-turn digests.
// No React, store, or Tauri imports.

export type InsightRecord =
  | { kind: "user_prompt"; ts: string | null; text: string }
  | { kind: "assistant_text"; ts: string | null; text: string }
  | { kind: "tool_use"; ts: string | null; id: string; name: string; target: string | null; input: unknown | null }
  | {
      kind: "tool_result";
      ts: string | null;
      tool_use_id: string;
      is_error: boolean;
      text: string;
      lines_added: number | null;
      lines_removed: number | null;
    }
  | { kind: "usage"; ts: string | null; message_id: string; input_tokens: number; output_tokens: number };

export type ToolCategory = "read" | "edit" | "bash" | "search" | "web" | "agent" | "other";
export interface ToolCall {
  id: string;
  name: string;
  category: ToolCategory;
  target: string | null;
  status: "pending" | "ok" | "error";
  resultText: string | null;
}
export interface FileTouch { path: string; added: number; removed: number; edits: number }
export interface CommandRun { toolUseId: string; command: string; status: "pending" | "ok" | "error" }
export interface TurnError { toolUseId: string; toolName: string; message: string }
export interface TestCounts { passed: number; failed: number }
export interface AskOption { label: string; description: string; preview?: string }
export interface AskQuestion { question: string; header: string; multiSelect: boolean; options: AskOption[] }
export interface PendingQuestion { toolUseId: string; questions: AskQuestion[] }
export interface InsightTurn {
  index: number;
  prompt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  headline: string;
  finalText: string;
  tools: ToolCall[];
  activity: Record<ToolCategory, number>;
  files: FileTouch[];
  commands: CommandRun[];
  tests: TestCounts | null;
  errors: TurnError[];
  tokens: number;
}
export interface InsightModel { turns: InsightTurn[]; pendingQuestion: PendingQuestion | null }
export type HeadlineProvider = (turn: InsightTurn) => string;

export const MAX_TURNS = 50;
const EARLIER_PROMPT = "(earlier in this session)";
const ERROR_MESSAGE_MAX = 200;

const CATEGORY_BY_NAME: Record<string, ToolCategory> = {
  Read: "read", NotebookRead: "read",
  Edit: "edit", MultiEdit: "edit", Write: "edit", NotebookEdit: "edit", apply_patch: "edit",
  Bash: "bash", PowerShell: "bash", shell: "bash", exec: "bash", exec_command: "bash",
  Grep: "search", Glob: "search", LS: "search", ToolSearch: "search",
  WebFetch: "web", WebSearch: "web",
  Agent: "agent", Task: "agent",
};

export function toolCategory(name: string): ToolCategory {
  return Object.prototype.hasOwnProperty.call(CATEGORY_BY_NAME, name) ? CATEGORY_BY_NAME[name] : "other";
}

export function parseTestCounts(text: string): TestCounts | null {
  // cargo prints one "test result" line per test binary: sum them.
  const cargo = [...text.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length > 0) {
    return {
      passed: cargo.reduce((n, m) => n + Number(m[1]), 0),
      failed: cargo.reduce((n, m) => n + Number(m[2]), 0),
    };
  }
  const patterns = [
    /Tests\s+(?:(\d+) failed \| )?(\d+) passed/, // vitest
    /Tests:\s+(?:(\d+) failed, )?(\d+) passed/, // jest
    /=+ (?:(\d+) failed, )?(\d+) passed/, // pytest
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) return { passed: Number(m[2]), failed: m[1] ? Number(m[1]) : 0 };
  }
  return null;
}

export function headlineFrom(text: string, max = 100): string {
  const lines = text.split(/\r?\n/);
  let line = "";
  for (const raw of lines) {
    const cleaned = raw
      .replace(/^\s*(?:[#>]+\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
      .replace(/[#*`>]/g, "")
      .trim();
    if (cleaned) {
      line = cleaned;
      break;
    }
  }
  if (!line) return "";
  const sentence = /^.*?[.!?](?=\s|$)/.exec(line);
  const out = sentence ? sentence[0] : line;
  return out.length > max ? out.slice(0, max).trimEnd() + "..." : out;
}

export const defaultHeadline: HeadlineProvider = (turn) => {
  const h = headlineFrom(turn.finalText);
  if (h) return h;
  return turn.tools.some((t) => t.status === "pending") ? "Working..." : "(no reply)";
};

function firstLine(text: string): string {
  for (const l of text.split(/\r?\n/)) {
    const t = l.trim();
    if (t) return t.slice(0, ERROR_MESSAGE_MAX);
  }
  return "";
}

function emptyActivity(): Record<ToolCategory, number> {
  return { read: 0, edit: 0, bash: 0, search: 0, web: 0, agent: 0, other: 0 };
}

type ToolResultRecord = Extract<InsightRecord, { kind: "tool_result" }>;

function buildTurn(
  prompt: string,
  records: InsightRecord[],
  headline: HeadlineProvider,
  results: Map<string, ToolResultRecord>,
): InsightTurn {
  const tools: ToolCall[] = [];
  const activity = emptyActivity();
  const fileMap = new Map<string, FileTouch>();
  const commands: CommandRun[] = [];
  const errors: TurnError[] = [];
  const seenMessages = new Set<string>();
  let tokens = 0;
  let tests: TestCounts | null = null;
  let finalText = "";
  const stamps: string[] = [];

  for (const r of records) {
    if (r.ts) stamps.push(r.ts);
    if (r.kind === "assistant_text") {
      finalText = r.text;
    } else if (r.kind === "usage") {
      if (!seenMessages.has(r.message_id)) {
        seenMessages.add(r.message_id);
        tokens += r.input_tokens + r.output_tokens;
      }
    } else if (r.kind === "tool_use") {
      const res = results.get(r.id);
      const category = toolCategory(r.name);
      const status: ToolCall["status"] = !res ? "pending" : res.is_error ? "error" : "ok";
      tools.push({ id: r.id, name: r.name, category, target: r.target, status, resultText: res ? res.text : null });
      activity[category] += 1;
      if (category === "edit" && r.target) {
        const f = fileMap.get(r.target) ?? { path: r.target, added: 0, removed: 0, edits: 0 };
        f.edits += 1;
        f.added += res?.lines_added ?? 0;
        f.removed += res?.lines_removed ?? 0;
        fileMap.set(r.target, f);
      }
      if (category === "bash") {
        commands.push({ toolUseId: r.id, command: r.target ?? "", status });
        if (res) {
          const counts = parseTestCounts(res.text);
          if (counts) tests = counts;
        }
      }
    } else if (r.kind === "tool_result" && r.is_error) {
      const use = tools.find((t) => t.id === r.tool_use_id);
      errors.push({ toolUseId: r.tool_use_id, toolName: use?.name ?? "unknown", message: firstLine(r.text) });
    }
  }

  const startedAt = stamps.length > 0 ? stamps[0] : null;
  const endedAt = stamps.length > 0 ? stamps[stamps.length - 1] : null;
  let durationMs: number | null = null;
  if (stamps.length >= 2) {
    const d = Date.parse(stamps[stamps.length - 1]) - Date.parse(stamps[0]);
    durationMs = Number.isFinite(d) ? d : null;
  }

  const turn: InsightTurn = {
    index: 0,
    prompt,
    startedAt,
    endedAt,
    durationMs,
    headline: "",
    finalText,
    tools,
    activity,
    files: [...fileMap.values()],
    commands,
    tests,
    errors,
    tokens,
  };
  turn.headline = headline(turn);
  return turn;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseQuestions(input: unknown): AskQuestion[] {
  const raw = asRecord(input)?.questions;
  if (!Array.isArray(raw)) return [];
  const out: AskQuestion[] = [];
  for (const q of raw) {
    const rec = asRecord(q);
    if (!rec || typeof rec.question !== "string" || !rec.question) continue;
    const options: AskOption[] = [];
    if (Array.isArray(rec.options)) {
      for (const o of rec.options) {
        const orec = asRecord(o);
        if (!orec || typeof orec.label !== "string") continue;
        const opt: AskOption = {
          label: orec.label,
          description: typeof orec.description === "string" ? orec.description : "",
        };
        if (typeof orec.preview === "string") opt.preview = orec.preview;
        options.push(opt);
      }
    }
    out.push({
      question: rec.question,
      header: typeof rec.header === "string" ? rec.header : "",
      multiSelect: rec.multiSelect === true,
      options,
    });
  }
  return out;
}

const HOOK_ID_PREFIX = "hook-";

// The hook-reported record and the later transcript record carry the same
// tool_use id: keep the first position and fill in `input` if only the later
// one has it, so the tool is counted once.
function dedupeToolUses(records: InsightRecord[]): InsightRecord[] {
  const firstIndex = new Map<string, number>();
  const out: InsightRecord[] = [];
  for (const r of records) {
    if (r.kind !== "tool_use") {
      out.push(r);
      continue;
    }
    const at = firstIndex.get(r.id);
    if (at === undefined) {
      firstIndex.set(r.id, out.length);
      out.push(r);
      continue;
    }
    const first = out[at] as Extract<InsightRecord, { kind: "tool_use" }>;
    if (first.input == null && r.input != null) out[at] = { ...first, input: r.input };
  }
  return out;
}

function findPendingQuestion(records: InsightRecord[]): PendingQuestion | null {
  const answered = new Set<string>();
  let laterResult = false; // any tool_result after the current position
  let laterAsk = false; // a transcript AskUserQuestion after the current position
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.kind === "user_prompt") return null; // a later prompt means the question is stale
    if (r.kind === "tool_result") {
      answered.add(r.tool_use_id);
      laterResult = true;
    } else if (r.kind === "tool_use" && r.name === "AskUserQuestion") {
      const synthetic = r.id.startsWith(HOOK_ID_PREFIX);
      const isAnswered = answered.has(r.id) || (synthetic && (laterResult || laterAsk));
      if (!isAnswered) {
        const questions = parseQuestions(r.input);
        return questions.length > 0 ? { toolUseId: r.id, questions } : null;
      }
      if (!synthetic) laterAsk = true;
    }
  }
  return null;
}

export function buildInsightModel(rawRecords: InsightRecord[], headline: HeadlineProvider = defaultHeadline): InsightModel {
  const records = dedupeToolUses(rawRecords);
  const groups: Array<{ prompt: string; records: InsightRecord[] }> = [];
  let current: { prompt: string; records: InsightRecord[] } | null = null;
  for (const r of records) {
    if (r.kind === "user_prompt") {
      current = { prompt: r.text, records: [r] };
      groups.push(current);
    } else {
      if (!current) {
        current = { prompt: EARLIER_PROMPT, records: [] };
        groups.push(current);
      }
      current.records.push(r);
    }
  }
  // One map over ALL records: a result may land after a later user_prompt
  // (queued message, interrupt) and must still resolve the earlier turn's tool.
  const results = new Map<string, ToolResultRecord>();
  for (const r of records) if (r.kind === "tool_result") results.set(r.tool_use_id, r);
  const kept = groups.slice(-MAX_TURNS);
  const turns = kept.map((g, i) => {
    const t = buildTurn(g.prompt, g.records, headline, results);
    t.index = i + 1;
    return t;
  });
  turns.reverse();
  return { turns, pendingQuestion: findPendingQuestion(records) };
}
