import { describe, it, expect } from "vitest";
import {
  buildInsightModel,
  toolCategory,
  parseTestCounts,
  headlineFrom,
  MAX_TURNS,
  type InsightRecord,
  type ToolCategory,
} from "./insightModel";

const prompt = (text: string, ts: string | null = null): InsightRecord => ({ kind: "user_prompt", ts, text });
const reply = (text: string, ts: string | null = null): InsightRecord => ({ kind: "assistant_text", ts, text });
const use = (id: string, name: string, target: string | null = null, input: unknown = null, ts: string | null = null): InsightRecord => ({
  kind: "tool_use", ts, id, name, target, input,
});
const result = (
  id: string,
  text = "",
  opts: { is_error?: boolean; added?: number | null; removed?: number | null; ts?: string | null } = {},
): InsightRecord => ({
  kind: "tool_result", ts: opts.ts ?? null, tool_use_id: id, is_error: opts.is_error ?? false, text,
  lines_added: opts.added ?? null, lines_removed: opts.removed ?? null,
});
const usage = (message_id: string, input_tokens: number, output_tokens: number): InsightRecord => ({
  kind: "usage", ts: null, message_id, input_tokens, output_tokens,
});

describe("buildInsightModel", () => {
  it("splits turns at user prompts, newest first", () => {
    const m = buildInsightModel([prompt("one"), reply("a"), prompt("two"), reply("b")]);
    expect(m.turns.map((t) => t.prompt)).toEqual(["two", "one"]);
    expect(m.turns.map((t) => t.index)).toEqual([2, 1]);
    expect(m.turns[0].finalText).toBe("b");
  });

  it("records before first prompt form an earlier turn", () => {
    const m = buildInsightModel([reply("mid"), prompt("go"), reply("done")]);
    expect(m.turns).toHaveLength(2);
    expect(m.turns[1].prompt).toBe("(earlier in this session)");
    expect(m.turns[1].finalText).toBe("mid");
  });

  it("caps at 50 turns", () => {
    const recs: InsightRecord[] = [];
    for (let i = 0; i < 60; i++) recs.push(prompt(`p${i}`));
    const m = buildInsightModel(recs);
    expect(MAX_TURNS).toBe(50);
    expect(m.turns).toHaveLength(50);
    expect(m.turns[0].prompt).toBe("p59");
    expect(m.turns[49].prompt).toBe("p10");
    expect(m.turns[49].index).toBe(1);
    expect(m.turns[0].index).toBe(50);
  });

  it("aggregates files touched with line counts", () => {
    const m = buildInsightModel([
      prompt("x"),
      use("1", "Edit", "/a.ts"), result("1", "ok", { added: 3, removed: 1 }),
      use("2", "Write", "/a.ts"), result("2", "ok", { added: 5, removed: 0 }),
      use("3", "Edit", "/b.ts"), result("3", "ok"),
      use("4", "Read", "/c.ts"), result("4", "x"),
    ]);
    expect(m.turns[0].files).toEqual([
      { path: "/a.ts", added: 8, removed: 1, edits: 2 },
      { path: "/b.ts", added: 0, removed: 0, edits: 1 },
    ]);
    expect(m.turns[0].activity.edit).toBe(3);
    expect(m.turns[0].activity.read).toBe(1);
  });

  it("marks commands ok and error", () => {
    const m = buildInsightModel([
      prompt("x"),
      use("1", "Bash", "ls"), result("1", "files"),
      use("2", "Bash", "false"), result("2", "boom", { is_error: true }),
      use("3", "Bash", "sleep 9"),
    ]);
    expect(m.turns[0].commands.map((c) => [c.command, c.status])).toEqual([
      ["ls", "ok"], ["false", "error"], ["sleep 9", "pending"],
    ]);
    expect(m.turns[0].tools[2].status).toBe("pending");
  });

  it("takes the last test counts in the turn", () => {
    const m = buildInsightModel([
      prompt("x"),
      use("1", "Bash", "t"), result("1", "Tests: 1 failed, 4 passed"),
      use("2", "Bash", "t"), result("2", "Tests  12 passed (12)"),
      use("3", "Bash", "ls"), result("3", "nothing"),
    ]);
    expect(m.turns[0].tests).toEqual({ passed: 12, failed: 0 });
  });

  it("collects errors with first line", () => {
    const m = buildInsightModel([
      prompt("x"),
      use("1", "Bash", "c"), result("1", "\n\nfirst line\nsecond", { is_error: true }),
      use("2", "Edit", "/a"), result("2", "y".repeat(500), { is_error: true }),
    ]);
    expect(m.turns[0].errors[0]).toEqual({ toolUseId: "1", toolName: "Bash", message: "first line" });
    expect(m.turns[0].errors[1].message).toHaveLength(200);
  });

  it("dedupes usage by message id", () => {
    const m = buildInsightModel([prompt("x"), usage("m1", 10, 5), usage("m1", 10, 5), usage("m2", 1, 2)]);
    expect(m.turns[0].tokens).toBe(18);
  });

  it("computes duration from timestamps", () => {
    const m = buildInsightModel([
      prompt("x", "2026-01-01T00:00:00Z"), reply("y", "2026-01-01T00:00:05Z"),
      prompt("z", "2026-01-01T00:01:00Z"),
    ]);
    expect(m.turns[1].durationMs).toBe(5000);
    expect(m.turns[1].startedAt).toBe("2026-01-01T00:00:00Z");
    expect(m.turns[1].endedAt).toBe("2026-01-01T00:00:05Z");
    expect(m.turns[0].durationMs).toBeNull();
  });

  it("headline uses final text, or working/no reply", () => {
    const m = buildInsightModel([prompt("a"), reply("**Done.** More"), prompt("b"), use("1", "Bash", "x"), prompt("c")]);
    expect(m.turns[2].headline).toBe("Done.");
    expect(m.turns[1].headline).toBe("Working...");
    expect(m.turns[0].headline).toBe("(no reply)");
  });

  it("uses a custom headline provider", () => {
    const m = buildInsightModel([prompt("a")], () => "custom");
    expect(m.turns[0].headline).toBe("custom");
  });

  it("pending question present until its result arrives", () => {
    const input = {
      questions: [
        { question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "a" }, { label: "B", description: "b", preview: "p" }] },
        { question: "More?", header: "H2", multiSelect: true, options: [{ label: "X", description: "x" }] },
      ],
    };
    const recs = [prompt("x"), use("q1", "AskUserQuestion", null, input)];
    const m = buildInsightModel(recs);
    expect(m.pendingQuestion?.toolUseId).toBe("q1");
    expect(m.pendingQuestion?.questions).toHaveLength(2);
    expect(m.pendingQuestion?.questions[0].options[1]).toEqual({ label: "B", description: "b", preview: "p" });
    expect(m.pendingQuestion?.questions[1].multiSelect).toBe(true);
    expect(buildInsightModel([...recs, result("q1", "answered")]).pendingQuestion).toBeNull();
  });

  it("malformed question input yields null", () => {
    for (const input of [null, {}, { questions: "x" }, { questions: [{ header: "h" }, 5, null] }]) {
      expect(buildInsightModel([prompt("x"), use("q", "AskUserQuestion", null, input)]).pendingQuestion).toBeNull();
    }
  });
});

describe("toolCategory", () => {
  const table: Array<[string, ToolCategory]> = [
    ["Read", "read"], ["NotebookRead", "read"],
    ["Edit", "edit"], ["MultiEdit", "edit"], ["Write", "edit"], ["NotebookEdit", "edit"], ["apply_patch", "edit"],
    ["Bash", "bash"], ["PowerShell", "bash"], ["shell", "bash"], ["exec", "bash"], ["exec_command", "bash"],
    ["Grep", "search"], ["Glob", "search"], ["LS", "search"], ["ToolSearch", "search"],
    ["WebFetch", "web"], ["WebSearch", "web"],
    ["Agent", "agent"], ["Task", "agent"],
    ["mcp__foo__bar", "other"], ["Mystery", "other"],
  ];
  it.each(table)("categorizes %s as %s", (name, cat) => {
    expect(toolCategory(name)).toBe(cat);
  });
});

describe("parseTestCounts", () => {
  it("parses each runner", () => {
    expect(parseTestCounts("test result: FAILED. 38 passed; 2 failed; 0 ignored")).toEqual({ passed: 38, failed: 2 });
    expect(parseTestCounts("test result: ok. 5 passed; 0 failed")).toEqual({ passed: 5, failed: 0 });
    expect(parseTestCounts("Tests  12 passed (12)")).toEqual({ passed: 12, failed: 0 });
    expect(parseTestCounts("Tests  1 failed | 12 passed (13)")).toEqual({ passed: 12, failed: 1 });
    expect(parseTestCounts("Tests: 1 failed, 4 passed")).toEqual({ passed: 4, failed: 1 });
    expect(parseTestCounts("==== 2 failed, 10 passed in 1.2s ====")).toEqual({ passed: 10, failed: 2 });
    expect(parseTestCounts("hello world")).toBeNull();
  });
});

describe("headlineFrom", () => {
  it("strips markdown and truncates", () => {
    expect(headlineFrom("## **Fixed** the `bug`. Then more")).toBe("Fixed the bug.");
    expect(headlineFrom("- > item one\nsecond")).toBe("item one");
    const long = "a".repeat(150);
    const h = headlineFrom(long, 100);
    expect(h).toBe("a".repeat(100) + "...");
    expect(headlineFrom("")).toBe("");
  });
  it("a question followed by a later user_prompt is stale", () => {
    const input = { questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "A", description: "a" }] }] };
    const recs = [prompt("x"), use("q1", "AskUserQuestion", null, input), prompt("after resume")];
    expect(buildInsightModel(recs).pendingQuestion).toBeNull();
  });

  it("a result landing after a later user_prompt still resolves the earlier turn's tool", () => {
    const recs = [prompt("one"), use("t1", "Bash", "ls"), prompt("two"), result("t1", "done")];
    const m = buildInsightModel(recs);
    const turn1 = m.turns.find((t) => t.prompt === "one")!;
    expect(turn1.tools[0].status).toBe("ok");
    expect(turn1.headline).not.toBe("Working...");
    const errRecs = [prompt("one"), use("t1", "Bash", "ls"), prompt("two"), result("t1", "bad", { is_error: true })];
    expect(buildInsightModel(errRecs).turns.find((t) => t.prompt === "one")!.tools[0].status).toBe("error");
  });
});
