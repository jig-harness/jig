// The turn-budget guard, fed transcripts shaped like a runtime's: one JSON
// record per line, several assistant records per round-trip sharing one
// requestId, tool results as user records with toolUseResult, and prompts as
// user records with promptSource. Every case spawns the hook as the runtime
// does, with the payload on standard input and the knobs in the environment.
import { afterAll, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expectSpawnExit,
  expectSpawnExitNot,
} from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  CHECKPOINT_BYTES,
  CHECKPOINT_WINDOWS,
  checkpointRanges,
  classify,
  CouldNotCheck,
  decide,
  freshState,
  parseCall,
  scan,
  settle,
  shellWord,
  STALLED_AFTER,
  UNSUPPORTED_AFTER,
} from "../turn-budget-guard.ts";

const hook = join(import.meta.dir, "..", "turn-budget-guard.ts");
const hooksJson = join(import.meta.dir, "..", "hooks.json");

// A small cap keeps the fixtures short: the margin opens at 90 of 100.
const BUDGET = 100;
const MARGIN = 10;

interface Session {
  transcript: string;
  stateDir: string;
  id: string;
  next: number;
}

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function session(): Session {
  const root = mkdtempSync(join(tmpdir(), "turn-budget-"));
  roots.push(root);
  const transcript = join(root, "transcript.jsonl");
  writeFileSync(transcript, "");
  return { transcript, stateDir: join(root, "state"), id: "sess-1", next: 1 };
}

const line = (s: Session, record: unknown) =>
  appendFileSync(s.transcript, `${JSON.stringify(record)}\n`);

/** One round-trip: `blocks` assistant records sharing one requestId. */
function turn(s: Session, blocks = 1, text = "ok", id?: string) {
  const requestId = id ?? `req_${s.next++}`;
  for (let i = 0; i < blocks; i++)
    line(s, {
      type: "assistant",
      requestId,
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  line(s, {
    type: "user",
    toolUseResult: { stdout: "" },
    message: { role: "user", content: [{ type: "tool_result", content: "" }] },
  });
}
const turns = (s: Session, n: number) => {
  for (let i = 0; i < n; i++) turn(s);
};
const prompt = (s: Session, text = "next task") =>
  line(s, {
    type: "user",
    promptSource: "typed",
    message: { role: "user", content: text },
  });
const compactSummary = (s: Session) =>
  line(s, {
    type: "user",
    isCompactSummary: true,
    message: { role: "user", content: "This session is being continued…" },
  });

interface Run {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function call(
  s: Session,
  payload: Record<string, unknown> = {},
  env: Record<string, string> = {},
): Run {
  const result = Bun.spawnSync([process.execPath, hook], {
    stdin: Buffer.from(
      JSON.stringify({
        session_id: s.id,
        transcript_path: s.transcript,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        ...payload,
      }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      JIG_TURN_BUDGET: String(BUDGET),
      JIG_TURN_BUDGET_MARGIN: String(MARGIN),
      JIG_TURN_BUDGET_REFIRE: "",
      JIG_TURN_BUDGET_STATE_DIR: s.stateDir,
      ...env,
    },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function context(run: Run): string | undefined {
  if (run.stdout === "") return undefined;
  const parsed = JSON.parse(run.stdout) as {
    hookSpecificOutput: { hookEventName: string; additionalContext: string };
  };
  expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  return parsed.hookSpecificOutput.additionalContext;
}

function quiet(run: Run, label: string) {
  expectSpawnExit(run, 0, label);
  expect(run.stdout, label).toBe("");
  expect(run.stderr, label).toBe("");
}

function fires(run: Run, label: string): string {
  expectSpawnExit(run, 0, label);
  const text = context(run);
  if (text === undefined) throw new Error(`${label}: expected a warning`);
  expect(text).toStartWith("TURN BUDGET:");
  return text;
}

const countOf = (text: string) =>
  Number(/about (\d+) of \d+ agentic turns/.exec(text)?.[1]);

const stateOf = (s: Session) =>
  JSON.parse(readFileSync(join(s.stateDir, s.id, "state.json"), "utf8")) as {
    count: number;
    offset: number;
    fired: number;
  };

test("under the margin the hook is silent", () => {
  const s = session();
  turns(s, 80);
  quiet(call(s), "80 of 100");
  expect(stateOf(s).count).toBe(80);
});

test("crossing the margin warns with the round-trip count, not the line count", () => {
  const s = session();
  for (let i = 0; i < 90; i++) turn(s, 3);
  const text = fires(call(s), "90 round-trips of 270 assistant lines");
  expect(countOf(text)).toBe(90);
  expect(text).toContain("About 10 agentic turns remain");
  expect(text).toContain("drive-state.ts' handoff <PR>");
});

test("the default interval warns twice: at the margin and at half of it", () => {
  const s = session();
  turns(s, 90);
  fires(call(s), "first, at 90");
  turns(s, 2);
  quiet(call(s), "92: still inside the first warning");
  turns(s, 3);
  const second = fires(call(s), "95: half the margin remains");
  expect(countOf(second)).toBe(95);
  turns(s, 10);
  quiet(call(s), "105: past the cap, both warnings given");
});

test("an explicit interval warns every that many turns, past the cap included", () => {
  const s = session();
  const env = { JIG_TURN_BUDGET_REFIRE: "4" };
  turns(s, 91);
  fires(call(s, {}, env), "first, at 91");
  turns(s, 3);
  quiet(call(s, {}, env), "94: three turns later");
  turns(s, 1);
  fires(call(s, {}, env), "95: four turns later");
  turns(s, 8);
  const late = fires(call(s, {}, env), "103: past the cap");
  expect(late).toContain("The cap is reached or passed");
});

test("a prompt restarts the count; a compaction summary does not", () => {
  const s = session();
  turns(s, 95);
  fires(call(s), "95");
  prompt(s);
  turns(s, 5);
  quiet(call(s), "5 since the prompt");
  expect(stateOf(s).count).toBe(5);
  turns(s, 80);
  compactSummary(s);
  turns(s, 10);
  const text = fires(call(s), "95 since the prompt, summary in between");
  expect(countOf(text)).toBe(95);
});

test("a repeated requestId is one turn, however far apart", () => {
  const s = session();
  turns(s, 50);
  call(s);
  for (let i = 1; i <= 50; i++) turn(s, 1, "replayed", `req_${i}`);
  quiet(call(s), "the replay adds nothing");
  expect(stateOf(s).count).toBe(50);
});

test("quoted transcript text and nested keys are not structure", () => {
  const s = session();
  turns(s, 95);
  fires(call(s), "95");
  // Assistant text that quotes a prompt record must not restart the count.
  turn(s, 1, '{"type":"user","promptSource":"typed"}');
  // A tool result quoting an assistant record must not count.
  line(s, {
    type: "user",
    toolUseResult: { stdout: '{"type":"assistant","requestId":"req_zzz"}' },
    message: { role: "user", content: [{ type: "tool_result", content: "x" }] },
  });
  // A nested requestId must not shadow the top-level one.
  line(s, {
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", input: { requestId: "nested" } }],
    },
    requestId: "req_top",
  });
  call(s);
  expect(stateOf(s).count).toBe(97);
  // A prompt whose whole text is a key name still restarts the count.
  prompt(s, "toolUseResult");
  call(s);
  expect(stateOf(s).count).toBe(0);
});

test("a half-written last line waits for its newline", () => {
  const s = session();
  turns(s, 89);
  appendFileSync(
    s.transcript,
    JSON.stringify({ type: "assistant", requestId: "req_half" }),
  );
  quiet(call(s), "89 complete, one line mid-write");
  expect(stateOf(s).count).toBe(89);
  appendFileSync(s.transcript, "\n");
  const text = fires(call(s), "the line completed");
  expect(countOf(text)).toBe(90);
});

test("a rewritten transcript and a corrupt state file are rescanned", () => {
  const s = session();
  turns(s, 60);
  call(s);
  writeFileSync(s.transcript, "");
  turns(s, 10);
  call(s);
  expect(stateOf(s).count).toBe(10);
  writeFileSync(join(s.stateDir, s.id, "state.json"), "4723");
  turns(s, 5);
  call(s);
  expect(stateOf(s).count).toBe(15);
});

test("a transcript emptied, or rewritten in place at the same size, is rescanned", () => {
  const s = session();
  turns(s, 60);
  call(s);
  // Emptied: the reset is kept even though no byte follows it yet.
  writeFileSync(s.transcript, "");
  quiet(call(s), "emptied");
  expect(stateOf(s).offset).toBe(0);
  turns(s, 70);
  call(s);
  expect(stateOf(s).count).toBe(70);
  // Rewritten in place to the same size: 30 turns and a filler record.
  const size = readFileSync(s.transcript).byteLength;
  const t = session();
  turns(t, 30);
  const head = readFileSync(t.transcript, "utf8");
  const filler = JSON.stringify({ type: "attachment", pad: "" });
  const pad = "x".repeat(size - Buffer.byteLength(head) - filler.length - 1);
  writeFileSync(
    s.transcript,
    `${head}${JSON.stringify({ type: "attachment", pad })}\n`,
  );
  expect(readFileSync(s.transcript).byteLength).toBe(size);
  call(s);
  expect(stateOf(s).count).toBe(30);
});

test("a transcript rewritten in place with its size and final record kept is rescanned", () => {
  const s = session();
  for (let i = 0; i < 60; i++) turn(s, 1, "x".repeat(200));
  call(s);
  expect(stateOf(s).count).toBe(60);
  const size = readFileSync(s.transcript).byteLength;
  const original = readFileSync(s.transcript, "utf8");
  const last = original.slice(
    original.lastIndexOf("\n", original.length - 2) + 1,
  );
  // 95 shorter turns, then a filler record, then the old final record
  // unchanged: the inode, the size and every trailing byte still match.
  const t = session();
  turns(t, 95);
  const head = readFileSync(t.transcript, "utf8");
  const body = head.slice(0, head.length - last.length);
  const filler = JSON.stringify({ type: "attachment", pad: "" });
  const pad = "x".repeat(
    size -
      Buffer.byteLength(body) -
      filler.length -
      1 -
      Buffer.byteLength(last),
  );
  writeFileSync(
    s.transcript,
    `${body}${JSON.stringify({ type: "attachment", pad })}\n${last}`,
  );
  expect(readFileSync(s.transcript).byteLength).toBe(size);
  expect(readFileSync(s.transcript, "utf8").endsWith(last)).toBe(true);
  call(s);
  expect(stateOf(s).count).toBe(95);
});

test("a transcript rewritten in place and grown, a checkpointed byte changed, is rescanned", () => {
  const s = session();
  // Uneven lengths, so the windows do not all fall on the same field.
  for (let i = 0; i < 60; i++) turn(s, 1, "x".repeat(200 + 37 * (i % 5)));
  call(s);
  const consumed = stateOf(s).offset;
  const ranges = checkpointRanges(consumed);
  expect(ranges.length).toBe(CHECKPOINT_WINDOWS);
  // Break one assistant record inside a middle window, then grow the file:
  // only the checkpoint tells this from an append, and only a rescan sees it.
  const bytes = readFileSync(s.transcript);
  const x = "x".charCodeAt(0);
  const at = ranges
    .slice(1, -1)
    .map(([a, b]) => bytes.subarray(0, b).indexOf(x, a))
    .find((i) => i >= 0);
  expect(at).toBeDefined();
  bytes[at ?? 0] = '"'.charCodeAt(0);
  writeFileSync(s.transcript, bytes);
  turns(s, 5);
  const rescanned = call(s);
  expectSpawnExit(rescanned, 1, "a rewritten record");
  expect(rescanned.stderr).toContain("are not JSON");
  expect(stateOf(s).count).toBe(64);
  expect(stateOf(s).offset).toBe(readFileSync(s.transcript).byteLength);
});

test("an unchanged transcript is not read again", () => {
  if (process.platform === "win32" || process.getuid?.() === 0) return;
  const s = session();
  turns(s, 60);
  call(s);
  const before = stateOf(s);
  // Unreadable but unchanged: a call that read it would report could-not-check.
  chmodSync(s.transcript, 0o000);
  try {
    quiet(call(s), "unchanged");
  } finally {
    chmodSync(s.transcript, 0o600);
  }
  expect(stateOf(s)).toEqual(before);
});

test("checkpointRanges: bounded windows from the first byte to the last", () => {
  expect(checkpointRanges(0)).toEqual([[0, 0]]);
  const small = CHECKPOINT_WINDOWS * CHECKPOINT_BYTES;
  expect(checkpointRanges(small)).toEqual([[0, small]]);
  for (const offset of [small + 1, 1_000_003, 64 * 1024 * 1024]) {
    const ranges = checkpointRanges(offset);
    expect(ranges.length).toBe(CHECKPOINT_WINDOWS);
    expect(ranges[0]).toEqual([0, CHECKPOINT_BYTES]);
    expect(ranges.at(-1)).toEqual([offset - CHECKPOINT_BYTES, offset]);
    const read = ranges.reduce((sum, [a, b]) => sum + b - a, 0);
    expect(read).toBe(CHECKPOINT_WINDOWS * CHECKPOINT_BYTES);
    for (const [a, b] of ranges) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(offset);
    }
  }
});

test("a record line that is not JSON is reported, even after records were read", () => {
  const s = session();
  prompt(s);
  turns(s, 5);
  quiet(call(s), "5 readable turns");
  appendFileSync(s.transcript, '{"type":"assistant","requestId":"req_x",\n');
  const broken = call(s);
  expectSpawnExit(broken, 1, "a broken record");
  expect(broken.stdout).toBe("");
  expect(broken.stderr).toContain("1 line(s) of");
  expect(broken.stderr).toContain("are not JSON");
  turns(s, 1);
  quiet(call(s), "reported already");
  // When a warning is due, the warning carries it instead.
  turns(s, 90);
  appendFileSync(s.transcript, '{"type":"assistant","requestId":"req_y",\n');
  const text = fires(call(s), "96 turns and a broken record");
  expect(text).toContain("The count may be low:");
});

test("a prompt answered in a format this guard does not read is reported", () => {
  const s = session();
  prompt(s);
  turns(s, 3);
  call(s);
  prompt(s);
  for (let i = 0; i < UNSUPPORTED_AFTER; i++)
    line(s, { type: "assistant", request_id: `req_${i}`, message: {} });
  const run = call(s);
  expectSpawnExit(run, 1, "assistant records without requestId");
  expect(run.stderr).toContain("no round-trip recognised");
  expect(run.stderr).toContain("since the last prompt");
});

test("a format change part-way through a prompt's answer is reported", () => {
  const s = session();
  prompt(s);
  turns(s, 3);
  quiet(call(s), "three round-trips");
  // The count stops at 3 while the round-trips go on in another shape.
  for (let i = 0; i < STALLED_AFTER - 1; i++)
    line(s, { type: "assistant", request_id: `req_${i}`, message: {} });
  quiet(call(s), "short of the run that reports it");
  line(s, { type: "assistant", request_id: "req_last", message: {} });
  const run = call(s);
  expectSpawnExit(run, 1, "a run of assistant records without requestId");
  expect(run.stderr).toContain("assistant records in a row");
  expect(run.stderr).toContain("after 3 round-trip(s) counted");
  // A recognised record ends the run: interleaved strays are not a format.
  const t = session();
  prompt(t);
  for (let i = 0; i < STALLED_AFTER * 2; i++) {
    line(t, { type: "assistant", message: {} });
    turn(t);
  }
  quiet(call(t), "strays between recognised round-trips");
});

test("the handoff command is one shell word per path, spaces included", () => {
  const root = mkdtempSync(join(tmpdir(), "turn-budget-"));
  roots.push(root);
  const plugin = join(root, "plugin cache", "jig's");
  const source = join(import.meta.dir, "..", "..");
  mkdirSync(join(plugin, "hooks"), { recursive: true });
  cpSync(
    join(source, "hooks", "turn-budget-guard.ts"),
    join(plugin, "hooks", "turn-budget-guard.ts"),
  );
  cpSync(join(source, "shared"), join(plugin, "shared"), { recursive: true });
  const scripts = join(plugin, "skills", "drive-pr", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(
    join(scripts, "drive-state.ts"),
    'console.log(process.argv.slice(2).join(","));\n',
  );
  const s = session();
  turns(s, 95);
  const result = Bun.spawnSync(
    [process.execPath, join(plugin, "hooks", "turn-budget-guard.ts")],
    {
      stdin: Buffer.from(
        JSON.stringify({ session_id: s.id, transcript_path: s.transcript }),
      ),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        JIG_TURN_BUDGET: String(BUDGET),
        JIG_TURN_BUDGET_MARGIN: String(MARGIN),
        JIG_TURN_BUDGET_STATE_DIR: s.stateDir,
      },
    },
  );
  const text = fires(
    {
      exitCode: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    },
    "from a path with spaces",
  );
  const command = /that is `([^`]+)`/.exec(text)?.[1] ?? "missing";
  const shell = Bun.spawnSync(
    [
      "sh",
      "-c",
      command.replace("<PR>", "7").replace(/^bun /, `"${process.execPath}" `),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(shell.stderr.toString()).toBe("");
  expect(shell.stdout.toString().trim()).toBe("handoff,7");
  expect(shellWord("a'b")).toBe(`'a'\\''b'`);
});

test("multi-byte text keeps the byte offset in step", () => {
  const s = session();
  turn(s, 1, "Übergabe geschrieben — señal ✓ 日本語");
  call(s);
  turns(s, 94);
  const text = fires(call(s), "95 with a multi-byte first turn");
  expect(countOf(text)).toBe(95);
  expect(stateOf(s).offset).toBe(readFileSync(s.transcript).byteLength);
});

test("concurrent copies on one session converge on one count", async () => {
  const s = session();
  turns(s, 40);
  const copies = Array.from({ length: 8 }, () =>
    Bun.spawn([process.execPath, hook], {
      stdin: Buffer.from(
        JSON.stringify({ session_id: s.id, transcript_path: s.transcript }),
      ),
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        JIG_TURN_BUDGET: String(BUDGET),
        JIG_TURN_BUDGET_STATE_DIR: s.stateDir,
      },
    }),
  );
  for (const copy of copies) {
    const [exitCode, stderr] = await Promise.all([
      copy.exited,
      new Response(copy.stderr).text(),
    ]);
    expectSpawnExit({ exitCode, stdout: null, stderr }, 0, "a copy");
  }
  expect(stateOf(s).count).toBe(40);
});

test("a subagent's call and a budget of 0 are out of scope and silent", () => {
  const s = session();
  turns(s, 95);
  quiet(call(s, { agent_id: "agent-7" }), "subagent");
  expect(existsSync(s.stateDir)).toBe(false);
  quiet(call(s, {}, { JIG_TURN_BUDGET: "0" }), "disabled");
  // Switched off, the other knobs are not read, whatever they hold.
  quiet(
    call(s, {}, { JIG_TURN_BUDGET: "0", JIG_TURN_BUDGET_MARGIN: "invalid" }),
    "disabled, with a bad margin",
  );
  expect(existsSync(s.stateDir)).toBe(false);
});

test("what it cannot check lets the call through and says so", () => {
  const s = session();
  turns(s, 95);
  const cases: [
    string,
    Record<string, unknown>,
    Record<string, string>,
    string,
  ][] = [
    [
      "no transcript",
      { transcript_path: join(s.stateDir, "none") },
      {},
      "cannot read the transcript",
    ],
    [
      "no transcript_path",
      { transcript_path: undefined },
      {},
      "names no transcript_path",
    ],
    ["session id ..", { session_id: ".." }, {}, "session_id"],
    ["session id with a slash", { session_id: "a/b" }, {}, "session_id"],
    [
      "budget not a number",
      {},
      { JIG_TURN_BUDGET: "lots" },
      "JIG_TURN_BUDGET is not a whole number",
    ],
    [
      "budget past a safe whole number",
      {},
      { JIG_TURN_BUDGET: "9".repeat(400) },
      "JIG_TURN_BUDGET is not a whole number",
    ],
  ];
  for (const [label, payload, env, reason] of cases) {
    const run = call(s, payload, env);
    expectSpawnExit(run, 1, label);
    expectSpawnExitNot(run, 2, label);
    expect(run.stdout, label).toBe("");
    expect(run.stderr, label).toContain("could not check");
    expect(run.stderr, label).toContain(reason);
  }
  const notJson = Bun.spawnSync([process.execPath, hook], {
    stdin: Buffer.from("not json"),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, JIG_TURN_BUDGET_STATE_DIR: s.stateDir },
  });
  expectSpawnExit(
    {
      ...notJson,
      stdout: notJson.stdout.toString(),
      stderr: notJson.stderr.toString(),
    },
    1,
    "payload not JSON",
  );
  expect(notJson.stderr.toString()).toContain("not JSON");
  // A state directory that cannot be created: a file sits where it should be.
  const u = session();
  mkdirSync(u.stateDir, { recursive: true });
  writeFileSync(join(u.stateDir, u.id), "");
  turns(u, 1);
  const blocked = call(u);
  expectSpawnExit(blocked, 1, "state directory is a file");
  expect(blocked.stderr).toContain("state directory");
});

test("a transcript in another format is reported once, then left alone", () => {
  const s = session();
  for (let i = 0; i < UNSUPPORTED_AFTER; i++)
    line(s, { type: "response_item", payload: { role: "assistant", i } });
  appendFileSync(s.transcript, '{"requestId": not json\n');
  const first = call(s);
  expectSpawnExit(first, 1, "first call");
  expect(first.stdout).toBe("");
  expect(first.stderr).toContain("not in the format this guard reads");
  expect(first.stderr).toContain("the last line that is not JSON:");
  line(s, { type: "response_item", payload: { role: "assistant", i: 99 } });
  quiet(call(s), "reported already");
  // Short of the threshold nothing is reported: the prompt may still come.
  const t = session();
  for (let i = 0; i < UNSUPPORTED_AFTER - 1; i++)
    line(t, { type: "attachment", i });
  quiet(call(t), "49 records");
  prompt(t);
  turns(t, 95);
  fires(call(t), "a prompt made it a transcript this guard reads");
});

test("scan and decide: the pure halves", () => {
  const encoder = new TextEncoder();
  const empty = scan(encoder.encode("no newline yet"), freshState());
  expect(empty.offset).toBe(0);
  const two = scan(
    encoder.encode(
      '{"type":"assistant","requestId":"a"}\n{"type":"assistant","requestId":"a"}\n{"type":"assistant","requestId":"b"}\n{"type":"assist',
    ),
    freshState(),
  );
  expect(two.count).toBe(2);
  expect(two.records).toBe(3);
  expect(two.offset).toBe(two.offset | 0);
  const t = { budget: 100, margin: 10 };
  expect(decide({ ...freshState(), count: 89 }, t)).toBeUndefined();
  expect(decide({ ...freshState(), count: 90 }, t)).toBe(91);
  expect(decide({ ...freshState(), count: 92, fired: 91 }, t)).toBeUndefined();
  expect(decide({ ...freshState(), count: 95, fired: 91 }, t)).toBe(101);
  expect(
    decide({ ...freshState(), count: 120, fired: 101 }, t),
  ).toBeUndefined();
  const every = { ...t, refire: 4 };
  expect(decide({ ...freshState(), count: 90 }, every)).toBe(91);
  expect(
    decide({ ...freshState(), count: 93, fired: 91 }, every),
  ).toBeUndefined();
  expect(decide({ ...freshState(), count: 94, fired: 91 }, every)).toBe(95);
  // A warning at count zero (a margin as wide as the budget) differs from none.
  expect(
    decide({ ...freshState(), count: 0 }, { budget: 10, margin: 10 }),
  ).toBe(1);
});

test("classify: the recogniser reads structure, never text", () => {
  expect(
    classify('{"type":"assistant","requestId":"r1","message":{}}'),
  ).toEqual({ id: "r1" });
  expect(classify('{"type":"user","promptSource":"sdk","message":{}}')).toBe(
    "prompt",
  );
  expect(
    classify(
      '{"type":"user","toolUseResult":{},"message":{"content":"\\"requestId\\":\\"x\\""}}',
    ),
  ).toBeUndefined();
  // An assistant record without a request id this guard reads is told apart,
  // so a run of them is noticed.
  expect(classify('{"type":"assistant","requestId":""}')).toBe("unrecognised");
  expect(
    classify('{"type":"assistant","message":{"requestId":"nested"}}'),
  ).toBe("unrecognised");
  expect(classify('{"type":"assistant","request_id":"r1"}')).toBe(
    "unrecognised",
  );
  expect(
    classify('{"type":"user","isCompactSummary":true,"message":{}}'),
  ).toBeUndefined();
  expect(classify('{"type":"attachment"}')).toBeUndefined();
  expect(classify('["requestId"]')).toBeUndefined();
  const broken = classify('{"requestId":"r1",');
  expect(
    typeof broken === "object" && broken !== null && "unreadable" in broken,
  ).toBe(true);
});

test("parseCall: the payload's fields, and what is out of scope or unreadable", () => {
  expect(
    parseCall({
      session_id: "s",
      transcript_path: "/t",
      hook_event_name: "PreToolUse",
    }),
  ).toEqual({ transcript: "/t", session: "s", event: "PreToolUse" });
  expect(parseCall({ session_id: "s", transcript_path: "/t" })?.event).toBe(
    "PreToolUse",
  );
  expect(
    parseCall({ session_id: "s", transcript_path: "/t", agent_id: "a1" }),
  ).toBeUndefined();
  for (const payload of [
    null,
    "text",
    { session_id: "s" },
    { session_id: "s", transcript_path: "" },
    { transcript_path: "/t" },
    { session_id: ".", transcript_path: "/t" },
    { session_id: "a/b", transcript_path: "/t" },
  ])
    expect(() => parseCall(payload)).toThrow(CouldNotCheck);
});

test("settle: a warning, a quiet call, or a transcript this guard does not read", () => {
  const t = { budget: 100, margin: 10 };
  const quietState = { ...freshState(), count: 50, records: 60 };
  expect(settle(quietState, t)).toEqual({
    state: quietState,
    warn: false,
    report: undefined,
  });
  const due = { ...quietState, count: 95 };
  expect(settle(due, t)).toEqual({
    state: { ...due, fired: 96 },
    warn: true,
    report: undefined,
  });
  // Lines that were not JSON are reported once, with or without a warning.
  const short = { ...due, unreadable: "Unexpected token", unreported: 2 };
  expect(settle(short, t)).toEqual({
    state: { ...short, unreported: 0, fired: 96 },
    warn: true,
    report: "unreadable",
  });
  expect(settle({ ...short, count: 50 }, t).report).toBe("unreadable");
  const foreign = {
    ...freshState(),
    records: UNSUPPORTED_AFTER,
    unreadable: "Unexpected token",
    unreported: 1,
  };
  const first = settle(foreign, t);
  expect(first).toEqual({
    state: { ...foreign, unreported: 0, warnedUnsupported: true },
    warn: false,
    report: "unsupported",
  });
  expect(settle(first.state, t).report).toBeUndefined();
  // A format change after a count that makes the warning due keeps the
  // warning and carries the notice with it.
  const stalledLate = { ...freshState(), count: 95, stalled: STALLED_AFTER };
  expect(settle(stalledLate, t)).toEqual({
    state: { ...stalledLate, warnedUnsupported: true, fired: 96 },
    warn: true,
    report: "unsupported",
  });
  // A prompt answered with a round-trip is a transcript this guard reads.
  expect(settle({ ...foreign, count: 1 }, t).report).toBe("unreadable");
});

test("hooks.json registers the guard before every tool call through the plugin root", () => {
  interface Entry {
    type: string;
    command: string;
    timeout: number;
  }
  interface Group {
    matcher?: string;
    hooks: Entry[];
  }
  const registration = JSON.parse(readFileSync(hooksJson, "utf8")) as {
    hooks: Record<string, Group[]>;
  };
  expect(Object.keys(registration.hooks)).toEqual(["PreToolUse"]);
  const groups = registration.hooks.PreToolUse as Group[];
  expect(groups).toHaveLength(1);
  const group = groups[0] as Group;
  expect(group.matcher).toBeUndefined();
  expect(group.hooks).toHaveLength(1);
  const entry = group.hooks[0] as Entry;
  expect(entry.type).toBe("command");
  expect(entry.timeout).toBeLessThanOrEqual(15);
  const match = /^bun "\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[^"]+)"$/.exec(
    entry.command,
  );
  if (match === null) throw new Error(`unexpected command: ${entry.command}`);
  const relative = String(match[1]);
  expect(relative).toBe("hooks/turn-budget-guard.ts");
  expect(existsSync(join(import.meta.dir, "..", "..", relative))).toBe(true);
});
