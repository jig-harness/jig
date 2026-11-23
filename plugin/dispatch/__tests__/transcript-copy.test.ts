/**
 * The copy of a run's transcript kept for a run that left no closing report:
 * found by its session id in its vendor's transcripts, its end copied,
 * redacted, into the run's own directory readable only by its owner, and
 * removed seven days after the steward's cause is applied or at the latest
 * after the retention, taking the run's bounded output and its row's path
 * with it.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordExit, writeRecord, type LaunchRecord } from "../lib/launches.ts";
import { holdCredential } from "../lib/provider-held.ts";
import { insertRow, readRows, type EndedRow } from "../lib/log.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import {
  claimStewardRecord,
  keepStewardRun,
  markStewardEffect,
  stewardRecords,
  submitStewardRecords,
  type StewardDigest,
} from "../lib/steward.ts";
import {
  CAUSE_RECORDED,
  codexSessionIn,
  COPY_BYTES,
  keepTranscriptCopy,
  pruneTranscriptCopies,
  readTranscriptCopy,
  runDir,
} from "../lib/transcript-copy.ts";

const roots: string[] = [];
afterAll(() => {
  closeStateDb();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "transcript-copy-"));
  roots.push(root);
  return root;
}

const SESSION = "0b6f2a1e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const ID = "20261114T101301Z-33c6fa5f";
const DAY = 86_400_000;

function record(
  configDir: string,
  fields: Partial<LaunchRecord> = {},
): LaunchRecord {
  return {
    version: 1,
    id: ID,
    token: "launch-token-1234",
    action: "followup",
    repo: "example-org/example-repo",
    repoPath: "/repo",
    pr: 9,
    item: null,
    account: "a",
    vendor: "claude",
    configDir,
    wallBackoffMs: 3_600_000,
    replaces: null,
    facts: "",
    createdAt: "2026-11-14T10:13:01.000Z",
    workspace: null,
    attempts: [],
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: "/followup",
    marker: null,
    sessionId: SESSION,
    ...fields,
  };
}

function claudeTranscript(configDir: string, lines: unknown[]): void {
  const dir = join(configDir, "projects", "-repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

describe("a Codex pass's session id", () => {
  it("is read from the header the pass printed, and nothing else passes for one", () => {
    expect(
      codexSessionIn(
        `OpenAI Codex v0.50\n--------\nworkdir: /repo\nsession id: ${SESSION.toUpperCase()}\n--------\n`,
      ),
    ).toBe(SESSION);
    expect(codexSessionIn(`\u001b[2msession id:\u001b[0m ${SESSION}`)).toBe(
      SESSION,
    );
    expect(codexSessionIn("session id: ../../etc/passwd")).toBeNull();
    expect(codexSessionIn(`the session id: ${SESSION} was said`)).toBeNull();
    expect(codexSessionIn(undefined)).toBeNull();
  });

  it("reads a valid thread ID from a Codex JSON startup event", () => {
    const startup = JSON.stringify({
      type: "thread.started",
      thread_id: SESSION.toUpperCase(),
    });
    expect(codexSessionIn(`diagnostic\n${startup}\n`)).toBe(SESSION);
    expect(codexSessionIn('{"type":"thread.started"')).toBeNull();
    expect(
      codexSessionIn(
        JSON.stringify({ type: "thread.started", thread_id: "../transcript" }),
      ),
    ).toBeNull();
    expect(
      codexSessionIn(
        JSON.stringify({ type: "turn.started", thread_id: SESSION }),
      ),
    ).toBeNull();
  });
});

describe("keeping a run's transcript copy", () => {
  it("copies a Claude Code transcript found by its session id, redacted, readable only by its owner", () => {
    const root = scratch();
    const config = join(root, "config");
    claudeTranscript(config, [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "Using ghp_abcdefghijkl1234567890 for me@example.com with launch-token-1234",
            },
          ],
        },
      },
    ]);
    const copy = keepTranscriptCopy(record(config), SESSION, root);
    expect(copy).toMatchObject({
      record: ID,
      session: SESSION,
      transcript: join(runDir(root, ID), "transcript.jsonl"),
      cut: false,
    });
    const text = readFileSync(String(copy?.transcript), "utf8");
    expect(text).toContain("<redacted>");
    expect(text).not.toContain("ghp_abcdefghijkl1234567890");
    expect(text).not.toContain("me@example.com");
    expect(text).not.toContain("launch-token-1234");
    expect(JSON.parse(text.trim())).toMatchObject({ type: "assistant" });
    expect(statSync(runDir(root, ID)).mode & 0o777).toBe(0o700);
    expect(statSync(String(copy?.transcript)).mode & 0o777).toBe(0o600);
    expect(readTranscriptCopy(ID, root)).toEqual(copy);
  });

  it("masks the launch token and a held provider credential in names, strings and numbers", () => {
    const root = scratch();
    const config = join(root, "config");
    const credential = "98765432101";
    claudeTranscript(config, [
      {
        type: "assistant",
        message: { content: [] },
        keep: "unrelated",
        extra: {
          "launch-token-1234": 1,
          "<redacted>": 2,
          [`key-${credential}`]: 3,
          number: Number(credential),
          text: `me@x.io-${credential}`,
        },
      },
    ]);
    holdCredential(ID, credential);
    try {
      const copy = keepTranscriptCopy(
        record(config, {
          provider: { provider: "p" },
        } as unknown as Partial<LaunchRecord>),
        SESSION,
        root,
      );
      const text = readFileSync(String(copy?.transcript), "utf8");
      expect(text).not.toContain("launch-token-1234");
      expect(text).not.toContain(credential);
      const parsed = JSON.parse(text.trim());
      expect(parsed.keep).toBe("unrelated");
      // The colliding names stay distinct fields, none lost (the token-named field is a credential key, so its value is masked).
      expect(parsed.extra["<redacted>#2"]).toBe(2);
      expect(Object.values(parsed.extra).sort()).toEqual(
        expect.arrayContaining([2, 3, "<redacted>"]),
      );
      expect(Object.keys(parsed.extra)).toHaveLength(5);
    } finally {
      holdCredential("none", "unused-placeholder");
    }
  });

  it("keeps an own constructor field and masks a field name a held secret would rename, with its value", () => {
    const root = scratch();
    const config = join(root, "config");
    claudeTranscript(config, [
      {
        type: "assistant",
        message: { content: [] },
        constructor: "plain",
        authorization: "some-other-opaque-value",
      },
    ]);
    holdCredential(ID, "authorization");
    try {
      const copy = keepTranscriptCopy(
        record(config, {
          provider: { provider: "p" },
        } as unknown as Partial<LaunchRecord>),
        SESSION,
        root,
      );
      const parsed = JSON.parse(
        readFileSync(String(copy?.transcript), "utf8").trim(),
      );
      expect(parsed.constructor).toBe("plain");
      expect(parsed.authorization).toBeUndefined();
      expect(parsed["<redacted>"]).toBe("<redacted>");
    } finally {
      holdCredential("none", "unused-placeholder");
    }
  });

  it("leaves out a line whose serialized form still matches a held secret, and marks the copy cut", () => {
    const root = scratch();
    const config = join(root, "config");
    claudeTranscript(config, [
      { type: "assistant", message: { content: [] }, keep: "one" },
      { type: "assistant", message: { content: [] }, "\nfixture-text": 1 },
    ]);
    holdCredential(ID, "\\nfixture-text");
    try {
      const copy = keepTranscriptCopy(
        record(config, {
          provider: { provider: "p" },
        } as unknown as Partial<LaunchRecord>),
        SESSION,
        root,
      );
      const text = readFileSync(String(copy?.transcript), "utf8");
      const kept = text
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(kept).toEqual([
        { type: "assistant", message: { content: [] }, keep: "one" },
        { type: "jig-omitted" },
      ]);
      expect(copy?.cut).toBe(true);
    } finally {
      holdCredential("none", "unused-placeholder");
    }
  });

  it("records no transcript when its only line cannot be kept", () => {
    const root = scratch();
    const config = join(root, "config");
    claudeTranscript(config, [
      { type: "assistant", message: { content: [] }, "\nfixture-text": 1 },
    ]);
    holdCredential(ID, "\\nfixture-text");
    try {
      const copy = keepTranscriptCopy(
        record(config, {
          provider: { provider: "p" },
        } as unknown as Partial<LaunchRecord>),
        SESSION,
        root,
      );
      expect(copy?.transcript).toBeNull();
      expect(copy?.missing).toContain("no line");
      expect(copy?.cut).toBe(true);
    } finally {
      holdCredential("none", "unused-placeholder");
    }
  });

  it("leaves out a line whose tool output holds JSON with a secret in its decoded form", () => {
    const root = scratch();
    const config = join(root, "config");
    const secret = 'ab"cd\\ef-credential';
    claudeTranscript(config, [
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c1",
          output: JSON.stringify({ output: `leaked ${secret}`, exit_code: 1 }),
        },
      },
    ]);
    holdCredential(ID, secret);
    try {
      const copy = keepTranscriptCopy(
        record(config, {
          provider: { provider: "p" },
        } as unknown as Partial<LaunchRecord>),
        SESSION,
        root,
      );
      expect(copy?.transcript).toBeNull();
      expect(copy?.cut).toBe(true);
    } finally {
      holdCredential("none", "unused-placeholder");
    }
  });

  it("leaves out lines whose JSON after a header, JSON string, deep nesting or credential key could hide a secret, and a marker-shaped source record", () => {
    const root = scratch();
    const config = join(root, "config");
    const secret = 'ab"cd\\ef-credential';
    const safe = { type: "assistant", message: "kept-evidence" };
    let deep: unknown = "x";
    for (let i = 0; i < 3000; i++) deep = [deep];
    claudeTranscript(config, [
      safe,
      { out: `Output:\n${JSON.stringify({ a: secret })}` },
      { out: JSON.stringify(JSON.stringify({ a: secret })) },
      { out: JSON.stringify({ password: "opaque value x" }) },
      { out: '{"big":9007199254740993}' },
      { out: `\`\`\`json\n${JSON.stringify({ a: secret })}\n\`\`\`\ntrailing` },
      { [JSON.stringify({ a: secret })]: 1 },
      {
        out: `note \`${JSON.stringify(secret).replace(/e/g, "\\u0065")}\` end`,
      },
      { deep },
      { out: "\\".repeat(512) },
      { type: "jig-omitted", marker: "source-marker-xyz" },
    ]);
    holdCredential(ID, secret);
    try {
      const copy = keepTranscriptCopy(
        record(config, {
          provider: { provider: "p" },
        } as unknown as Partial<LaunchRecord>),
        SESSION,
        root,
      );
      const text = readFileSync(String(copy?.transcript), "utf8");
      expect(text).toContain("kept-evidence");
      expect(text).not.toContain("opaque value");
      expect(text).not.toContain("ef-credential");
      expect(text).not.toContain("note ");
      expect(text).toContain("9007199254740993");
      expect(text).not.toContain("source-marker-xyz");
      expect(text).not.toContain("trailing");
      expect(
        text.split("\n").filter((l) => l.includes("jig-omitted")).length,
      ).toBeGreaterThan(0);
      expect(copy?.cut).toBe(true);
    } finally {
      holdCredential("none", "unused-placeholder");
    }
  });

  it("redacts structured tool inputs by their secret keys", () => {
    const root = scratch();
    const config = join(root, "config");
    claudeTranscript(config, [
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              input: {
                password: "hidden-password",
                nested: [{ api_key: "hidden-key", count: 3 }],
                authorization: { value: "hidden-header" },
              },
            },
          ],
        },
      },
    ]);
    const copy = keepTranscriptCopy(record(config), SESSION, root);
    const text = readFileSync(String(copy?.transcript), "utf8");
    for (const secret of ["hidden-password", "hidden-key", "hidden-header"])
      expect(text).not.toContain(secret);
    expect(JSON.parse(text.trim()).message.content[0].input).toEqual({
      password: "<redacted>",
      nested: [{ api_key: "<redacted>", count: 3 }],
      authorization: "<redacted>",
    });
  });

  it("keeps the end of a long transcript, within its bound, and says it was cut", () => {
    const root = scratch();
    const config = join(root, "config");
    const line = { type: "assistant", message: { content: "x".repeat(4000) } };
    const lines = Array.from({ length: 700 }, (_, i) => ({ ...line, n: i }));
    claudeTranscript(config, lines);
    const copy = keepTranscriptCopy(record(config), SESSION, root);
    expect(copy?.cut).toBe(true);
    const text = readFileSync(String(copy?.transcript), "utf8");
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(COPY_BYTES);
    const kept = text.trim().split("\n");
    expect(JSON.parse(kept.at(-1) ?? "{}").n).toBe(699);
  });

  it("finds a Codex rollout under the day it was made, by the session id it printed", () => {
    const root = scratch();
    const home = join(root, "codex");
    const dir = join(home, "sessions", "2026", "11", "14");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `rollout-2026-11-14T10-13-05-${SESSION}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: SESSION } })}\n`,
    );
    const copy = keepTranscriptCopy(
      record(home, { vendor: "codex", sessionId: null }),
      SESSION,
      root,
    );
    expect(copy?.transcript).not.toBeNull();
    expect(readFileSync(String(copy?.transcript), "utf8")).toContain(
      "session_meta",
    );
  });

  it("records why there is no copy, once, and an earlier copy stands", () => {
    const root = scratch();
    const config = join(root, "config");
    const none = keepTranscriptCopy(
      record(config, { vendor: "codex", sessionId: null }),
      null,
      root,
    );
    expect(none).toMatchObject({
      transcript: null,
      missing: "the Codex pass printed no session id",
    });
    claudeTranscript(config, [{ type: "assistant" }]);
    expect(keepTranscriptCopy(record(config), SESSION, root)).toEqual(none);
    const other = scratch();
    expect(
      keepTranscriptCopy(record(config, { configDir: other }), SESSION, other),
    ).toMatchObject({
      transcript: null,
      missing: "the vendor's transcript of the session was not found",
    });
  });
});

/** A followup record that ended with `context` and has its ended row, with a copy of its transcript. */
function endedWithCopy(root: string): void {
  const config = join(root, "config");
  claudeTranscript(config, [{ type: "assistant" }]);
  const r = record(config);
  writeRecord(r, root);
  recordExit(
    ID,
    { at: r.createdAt, code: 1, signal: null, context: "the output's end" },
    root,
  );
  const copy = keepTranscriptCopy(r, SESSION, root);
  const row: EndedRow = {
    kind: "ended",
    key: `ended ${ID}`,
    at: r.createdAt,
    repo: r.repo,
    stage: "followup",
    target: "PR #9",
    record: ID,
    account: "a",
    model: null,
    durationMs: 0,
    rounds: null,
    class: "unknown",
    reason: "exit 1",
    by: "none",
    transcript: String(copy?.transcript),
  };
  insertRow(stateDb(root), row);
}

function exitContext(root: string): unknown {
  const row = stateDb(root)
    .query("SELECT exit FROM launches WHERE id = ?")
    .get(ID) as { exit: string };
  return (JSON.parse(row.exit) as { context?: string }).context;
}

function endedRowOf(root: string): EndedRow | undefined {
  return readRows(undefined, undefined, root).find(
    (r): r is EndedRow => r.kind === "ended",
  );
}

/** A steward run whose cause record for the run was applied at `at`. */
function causeApplied(root: string, at: number): void {
  keepStewardRun(
    "steward-run",
    {
      version: 1,
      repo: "example-org/example-repo",
      drives: [],
      needs: [],
      queue: [],
      passes: [],
      failures: [],
      load: null,
    } as StewardDigest,
    0,
    root,
  );
  expect(
    submitStewardRecords(
      "steward-run",
      [
        {
          kind: "cause",
          record: ID,
          cause: "crashed",
          summary: "It stopped mid-test.",
          reason: "the excerpt ends in a crash",
        },
      ],
      root,
    ).ok,
  ).toBe(true);
  const [kept] = stewardRecords("example-org/example-repo", root);
  if (kept === undefined) throw new TypeError("no cause record");
  expect(claimStewardRecord(kept.id, root)).toBe(true);
  markStewardEffect(kept.id, CAUSE_RECORDED, root);
  stateDb(root)
    .query("UPDATE steward_records SET effect_at_ms = ? WHERE id = ?")
    .run(at, kept.id);
}

describe("removing a run's transcript copy", () => {
  it("keeps it for seven days after the steward's cause is applied, then removes it with the run's output and its row's path", () => {
    const root = scratch();
    endedWithCopy(root);
    const madeAt = Date.parse(String(readTranscriptCopy(ID, root)?.at));
    causeApplied(root, madeAt);
    expect(endedRowOf(root)?.transcript).toBe(
      join(runDir(root, ID), "transcript.jsonl"),
    );
    expect(pruneTranscriptCopies(madeAt + 6 * DAY, 30, root)).toEqual([]);
    expect(existsSync(runDir(root, ID))).toBe(true);
    expect(pruneTranscriptCopies(madeAt + 7 * DAY, 30, root)).toEqual([ID]);
    expect(existsSync(runDir(root, ID))).toBe(false);
    expect(exitContext(root)).toBeUndefined();
    expect(endedRowOf(root)?.record).toBe(ID);
    expect(endedRowOf(root)).not.toHaveProperty("transcript");
  });

  it("removes it at the latest after the retention, with no cause applied", () => {
    const root = scratch();
    endedWithCopy(root);
    const madeAt = Date.parse(String(readTranscriptCopy(ID, root)?.at));
    expect(pruneTranscriptCopies(madeAt + 29 * DAY, 30, root)).toEqual([]);
    expect(exitContext(root)).toBe("the output's end");
    expect(pruneTranscriptCopies(madeAt + 30 * DAY, 30, root)).toEqual([ID]);
    expect(existsSync(runDir(root, ID))).toBe(false);
  });

  it("removes a run directory whose description does not read once it is older than the retention", () => {
    const root = scratch();
    const dir = runDir(root, ID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "copy.json"), "not json");
    const old = (Date.now() - 31 * DAY) / 1000;
    utimesSync(dir, old, old);
    expect(pruneTranscriptCopies(Date.now(), 30, root)).toEqual([ID]);
  });
});
