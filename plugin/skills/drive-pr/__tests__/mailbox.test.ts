/**
 * mailbox.test.ts — `lib/state/mailbox.ts`, the drive-pr mailbox: absent vs
 * unreadable, directive folding (latest-per-class wins), the fail-closed
 * rule for a malformed DIRECTIVE line versus a merely-dropped malformed
 * NOTE, and the write-side validation `appendDirective` enforces. See that
 * module's own header for the reasoning; these tests are the probes for it.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { expectSpawnExited } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitError } from "../scripts/lib/cli.ts";
import {
  appendDirective,
  appendedSince,
  appendNote,
  appendOutboxRecord,
  foldGateState,
  inboxPath,
  isPushHeld,
  outboxPath,
  outboxRecordsForPr,
  readMailboxFile,
  repairInbox,
  unseenMessages,
} from "../scripts/lib/state/mailbox.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drive-pr-mailbox-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readMailboxFile", () => {
  it("reports absent for a file that does not exist", async () => {
    expect(readMailboxFile(join(dir, "nope.jsonl"))).toEqual({
      kind: "absent",
    });
  });

  it("reports unreadable for a path that exists but is not a regular file", async () => {
    const p = join(dir, "inbox.jsonl");
    mkdirSync(p); // a directory where a file was expected
    const r = readMailboxFile(p);
    expect(r.kind).toBe("unreadable");
  });

  it("reports unreadable, not absent, when a path COMPONENT exists but is not a directory (ENOTDIR)", async () => {
    // POSIX raises ENOTDIR only when something exists at a path component
    // that traversal needs to descend through but is the WRONG type (a
    // regular file sitting where a directory belongs) — never for
    // "genuinely nothing there", which ENOENT already covers on its own.
    // Treating ENOTDIR as `absent` folded a broken mailbox location as
    // CLEAR.
    const brokenMailboxDir = join(dir, "broken-mailbox");
    writeFileSync(brokenMailboxDir, "this is a file, not a directory");
    const r = readMailboxFile(join(brokenMailboxDir, "inbox.jsonl"));
    expect(r.kind).toBe("unreadable");
  });
});

/** Unwraps the `ok: true` case, throwing (with a useful message) otherwise. */
function okMessages(dir: string, pr: string) {
  const r = unseenMessages(dir, pr);
  if (!r.ok) throw new Error(`expected ok, got: ${r.why}`);
  return r;
}

describe("unseenMessages", () => {
  it("is empty against an absent inbox", async () => {
    const r = okMessages(dir, "999");
    expect(r.messages).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("returns appended messages scoped to the given PR, and drops ones stamped for another", async () => {
    await appendNote(dir, "999", "orchestrator", "for 999");
    await appendNote(dir, "111", "orchestrator", "for 111");
    const r = okMessages(dir, "999");
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.body).toBe("for 999");
  });

  it("excludes a message once the outbox has a record for its id SCOPED TO THE SAME PR — the outbox is the cursor", async () => {
    const msg = await appendNote(dir, "999", "orchestrator", "hello");
    expect(okMessages(dir, "999").messages).toHaveLength(1);
    await appendOutboxRecord(dir, {
      id: msg.id,
      ts: new Date().toISOString(),
      pr: "999",
      status: "received",
    });
    expect(okMessages(dir, "999").messages).toHaveLength(0);
  });

  it("does NOT let an outbox record for a DIFFERENT pr acknowledge this one — a worktree reused across PRs must not inherit a stale cursor", async () => {
    const msg = await appendNote(dir, "999", "orchestrator", "hello");
    await appendOutboxRecord(dir, {
      id: msg.id,
      ts: new Date().toISOString(),
      pr: "111", // same id, but acked for a DIFFERENT PR
      status: "received",
    });
    expect(okMessages(dir, "999").messages).toHaveLength(1);
  });

  it("drops a malformed NOTE line and reports it as a warning, without affecting other messages", async () => {
    await appendNote(dir, "999", "orchestrator", "good one");
    appendFileSync(
      inboxPath(dir),
      `${JSON.stringify({ id: "m-bad", ts: new Date().toISOString(), kind: "note", from: "x", pr: "999" })}\n`,
    ); // missing required `body`
    const r = okMessages(dir, "999");
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]?.body).toBe("good one");
    expect(r.warnings).toHaveLength(1);
  });

  it('reports ok: false — not a false-empty "nothing pending" — when the inbox is unreadable', async () => {
    mkdirSync(inboxPath(dir)); // a directory, not a file — 'unreadable'
    const r = unseenMessages(dir, "999");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("could not be read");
  });

  it("reports ok: false — never a silently-empty ack cursor that re-reports history — when the outbox is unreadable", async () => {
    await appendNote(dir, "999", "orchestrator", "hello");
    mkdirSync(outboxPath(dir)); // a directory, not a file — 'unreadable'
    const r = unseenMessages(dir, "999");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("could not be read");
  });
});

describe("outboxRecordsForPr", () => {
  it("is empty (ok: true) against an absent outbox", async () => {
    const r = outboxRecordsForPr(dir, "999");
    expect(r).toEqual({ ok: true, records: [], warnings: [] });
  });

  it("reports a malformed/unparsable outbox record as a warning, instead of silently dropping it", async () => {
    await appendOutboxRecord(dir, {
      id: "m-good",
      ts: new Date().toISOString(),
      pr: "999",
      status: "received",
    });
    appendFileSync(
      outboxPath(dir),
      `${JSON.stringify({ id: "m-bad", ts: new Date().toISOString(), pr: "999", status: "not-a-real-status" })}\n`,
    );
    const r = outboxRecordsForPr(dir, "999");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.records).toHaveLength(1);
      expect(r.warnings).toHaveLength(1);
    }
  });

  it("reports ok: false — not a false-empty result — against an unreadable outbox", async () => {
    mkdirSync(outboxPath(dir)); // a directory, not a file — 'unreadable'
    const r = outboxRecordsForPr(dir, "999");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("could not be read");
  });

  it('rejects a "done" record with a missing or empty response as malformed, rather than a silent unanswered completion', async () => {
    // A malformed writer or a hand-edited recovery line could produce
    // valid JSON with status: 'done' but no real response. Accepting it
    // would report the message as done with nothing IN it, while
    // `unseenMessages` treats the id as acknowledged and suppresses
    // redelivery — leaving the sender with neither a response nor a
    // warning.
    appendFileSync(
      outboxPath(dir),
      `${JSON.stringify({ id: "m-no-response", ts: new Date().toISOString(), pr: "999", status: "done" })}\n`,
    );
    appendFileSync(
      outboxPath(dir),
      `${JSON.stringify({ id: "m-empty-response", ts: new Date().toISOString(), pr: "999", status: "done", response: "" })}\n`,
    );
    const r = outboxRecordsForPr(dir, "999");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.records).toHaveLength(0);
      expect(r.warnings).toHaveLength(2);
    }
  });

  it('rejects a "received" record that carries a response — not an answer yet', async () => {
    appendFileSync(
      outboxPath(dir),
      `${JSON.stringify({ id: "m-premature", ts: new Date().toISOString(), pr: "999", status: "received", response: "too early" })}\n`,
    );
    const r = outboxRecordsForPr(dir, "999");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.records).toHaveLength(0);
      expect(r.warnings).toHaveLength(1);
    }
  });

  it("scopes records to the requested PR", async () => {
    await appendOutboxRecord(dir, {
      id: "m-1",
      ts: new Date().toISOString(),
      pr: "999",
      status: "received",
    });
    await appendOutboxRecord(dir, {
      id: "m-2",
      ts: new Date().toISOString(),
      pr: "111",
      status: "received",
    });
    const r = outboxRecordsForPr(dir, "999");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.records).toHaveLength(1);
      expect(r.records[0]?.id).toBe("m-1");
    }
  });
});

describe("foldGateState", () => {
  it("is clear when the inbox is absent", async () => {
    const r = foldGateState(dir, "999");
    expect(r).toEqual({
      ok: true,
      state: {
        "hold-push": { active: false, since: null, by: null },
        pause: { active: false, since: null, by: null },
        stop: { active: false, since: null, by: null },
      },
      warnings: [],
    });
  });

  it("activates hold-push on a directive and clears it on a matching resume", async () => {
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    let r = foldGateState(dir, "999");
    if (!r.ok) throw new Error("expected ok");
    expect(r.state["hold-push"].active).toBe(true);

    await appendDirective(dir, "999", "orchestrator", "resume", {
      target: "hold-push",
    });
    r = foldGateState(dir, "999");
    if (!r.ok) throw new Error("expected ok");
    expect(r.state["hold-push"].active).toBe(false);
  });

  it("the LATEST directive of a class wins, not the first", async () => {
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    await appendDirective(dir, "999", "orchestrator", "resume", {
      target: "hold-push",
    });
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    const r = foldGateState(dir, "999");
    if (!r.ok) throw new Error("expected ok");
    expect(r.state["hold-push"].active).toBe(true);
  });

  it("gate classes are independent — a stop directive does not touch hold-push", async () => {
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    await appendDirective(dir, "999", "orchestrator", "stop");
    const r = foldGateState(dir, "999");
    if (!r.ok) throw new Error("expected ok");
    expect(r.state["hold-push"].active).toBe(true);
    expect(r.state.stop.active).toBe(true);
    expect(r.state.pause.active).toBe(false);
  });

  it("ignores a directive stamped for a different PR", async () => {
    await appendDirective(dir, "111", "orchestrator", "hold-push");
    const r = foldGateState(dir, "999");
    if (!r.ok) throw new Error("expected ok");
    expect(r.state["hold-push"].active).toBe(false);
  });

  it("fails CLOSED (ok: false) when the inbox file exists but cannot be read", async () => {
    mkdirSync(inboxPath(dir)); // a directory, not a file — 'unreadable'
    const r = foldGateState(dir, "999");
    expect(r.ok).toBe(false);
  });

  it("fails CLOSED (ok: false) on a malformed DIRECTIVE line — unlike a malformed note", async () => {
    writeFileSync(
      inboxPath(dir),
      `${JSON.stringify({ id: "m-1", ts: new Date().toISOString(), kind: "directive", from: "x", pr: "999", command: "not-a-real-command" })}\n`,
    );
    const r = foldGateState(dir, "999");
    expect(r.ok).toBe(false);
  });

  it("fails CLOSED on a directive whose pr field is malformed (not a valid PR at all), rather than silently skipping it as out-of-scope", async () => {
    // A malformed `pr` (empty, non-numeric) does not name ANY
    // identifiable PR — it is exactly as ambiguous as a record naming no
    // PR at all, and must poison like the "no pr" / malformed-directive
    // case, not be skipped as though it belonged to a different,
    // legitimate PR.
    writeFileSync(
      inboxPath(dir),
      `${JSON.stringify({ id: "m-1", ts: new Date().toISOString(), kind: "directive", from: "x", pr: "", command: "hold-push" })}\n`,
    );
    const r = foldGateState(dir, "999");
    expect(r.ok).toBe(false);
  });

  it("fails CLOSED on a directive whose pr field is non-numeric garbage, rather than silently skipping it as out-of-scope", async () => {
    writeFileSync(
      inboxPath(dir),
      `${JSON.stringify({ id: "m-1", ts: new Date().toISOString(), kind: "directive", from: "x", pr: "abc", command: "hold-push" })}\n`,
    );
    const r = foldGateState(dir, "999");
    expect(r.ok).toBe(false);
  });

  it("fails CLOSED on a directive whose pr field is digits but NOT canonical (a leading zero), rather than silently skipping it as belonging to another PR", async () => {
    // `isDigits('0999')` is true, but `'0999'` is a DIFFERENT string from the
    // canonical `'999'` every writer in this module actually produces
    // (`resolvePrArg`'s own `BigInt(...).toString()`) — comparing it against
    // `pr` with plain `===` would read it as "a different, valid PR" and skip
    // it as out-of-scope, when it is really a corrupt or hand-edited record
    // that names no identifiable PR at all (an isDigits-only check is not
    // enough).
    writeFileSync(
      inboxPath(dir),
      `${JSON.stringify({ id: "m-1", ts: new Date().toISOString(), kind: "directive", from: "x", pr: "0999", command: "hold-push" })}\n`,
    );
    const r = foldGateState(dir, "999");
    expect(r.ok).toBe(false);
  });

  it("fails CLOSED on a directive whose pr field is '0' — digits and its own canonical form, but never a real PR number", async () => {
    // `'0'` is BOTH `isDigits` and its own canonical form
    // (`BigInt('0').toString() === '0'`), so a canonicality check alone still
    // accepted it as "a valid, different PR" and skipped it — but GitHub PR
    // numbers are never `0`, so this identifies no REAL PR any more than
    // `'0999'` or `'abc'` do.
    writeFileSync(
      inboxPath(dir),
      `${JSON.stringify({ id: "m-1", ts: new Date().toISOString(), kind: "directive", from: "x", pr: "0", command: "hold-push" })}\n`,
    );
    const r = foldGateState(dir, "999");
    expect(r.ok).toBe(false);
  });

  it("does NOT fail closed on a malformed NOTE line sharing the same inbox, but DOES report it as a warning", async () => {
    writeFileSync(
      inboxPath(dir),
      `${JSON.stringify({ id: "m-1", ts: new Date().toISOString(), kind: "note", from: "x", pr: "999" })}\n`, // missing `body`
    );
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    const r = foldGateState(dir, "999");
    if (!r.ok)
      throw new Error("a malformed NOTE must not poison the gate fold");
    expect(r.state["hold-push"].active).toBe(true);
    expect(r.warnings).toHaveLength(1);
  });

  it("does NOT report a warning for a genuinely well-formed note", async () => {
    await appendNote(dir, "999", "orchestrator", "a perfectly good note");
    const r = foldGateState(dir, "999");
    if (!r.ok) throw new Error("expected ok");
    expect(r.warnings).toEqual([]);
  });

  it("DOES fail closed on valid JSON that cannot be classified as either a note or a directive", async () => {
    for (const bad of [
      "null",
      "{}",
      "[]",
      '"just a string"',
      "42",
      JSON.stringify({ pr: "999", kind: "directiv" }), // misspelled kind
      JSON.stringify({ pr: "999" }), // no kind at all
    ]) {
      writeFileSync(inboxPath(dir), `${bad}\n`);
      const r = foldGateState(dir, "999");
      expect(r.ok).toBe(false);
    }
  });

  it("does NOT fail closed on a positively-typed note, even with an invalid `kind` sibling test alongside it", async () => {
    // Sanity: the fix above must not have widened the note carve-out itself
    // — a genuine `kind: 'note'` record is still exempt regardless of its
    // OTHER fields (see the malformed-NOTE test above), only records with
    // NO recognizable kind at all now poison.
    writeFileSync(
      inboxPath(dir),
      `${JSON.stringify({ id: "m-1", ts: new Date().toISOString(), kind: "note", from: "x", pr: "999", body: "hi" })}\n`,
    );
    const r = foldGateState(dir, "999");
    expect(r.ok).toBe(true);
  });

  it("DOES fail closed on a note record that ALSO carries a directive-only field, rather than waving it through as clear", async () => {
    // `parseInboxMessage`'s note branch only reads `body` — a well-formed
    // note with `command: 'hold-push'` riding along would otherwise pass
    // the note carve-out as an unambiguously clear note, even though it
    // looks exactly like an attempted (but malformed) directive. Neither
    // `parseInboxMessage` nor `repairInbox` can clean this up: the record
    // parses fine as valid JSON, so it survives repair untouched.
    for (const contaminated of [
      {
        id: "m-1",
        ts: new Date().toISOString(),
        kind: "note",
        from: "x",
        pr: "999",
        body: "hi",
        command: "hold-push",
      },
      {
        id: "m-1",
        ts: new Date().toISOString(),
        kind: "note",
        from: "x",
        pr: "999",
        body: "hi",
        target: "pause",
      },
    ]) {
      writeFileSync(inboxPath(dir), `${JSON.stringify(contaminated)}\n`);
      const r = foldGateState(dir, "999");
      expect(r.ok).toBe(false);
    }
  });

  it("DOES fail closed unconditionally on ANY line that fails to parse as JSON — no leniency, no classifier to defeat", async () => {
    // Each narrower heuristic tried here was defeated by a new counterexample —
    // see foldGateState's own comment. The fix is to have no classifier left:
    // every one of these poisons.
    for (const bad of [
      // A truncated NOTE tail — once treated as "safe to drop", no longer
      // exempt; appendLine's self-healing (below) means this can only be a
      // genuine, isolated interrupted-write tail now, recoverable via repair.
      '{"id":"m-1","ts":"2026-01-01T00:00:00.000Z","kind":"note","from":"x","pr":"999","body":"trunc',
      // A truncated DIRECTIVE tail.
      '{"id":"m-1","ts":"2026-01-01T00:00:00.000Z","kind":"directive","from":"x","pr":"999","command":"hold-p',
      // Truncated before "kind" was even reached.
      '{"id":"m-1","ts":"2026-01-01T00:00:00.000',
      // A directive-shaped line for a DIFFERENT PR — the PR-scoping
      // carve-out applied to structurally-parsed JSON only; an unparsable
      // line's claimed `pr` is not trustworthy evidence of anything.
      '{"id":"m-1","ts":"2026-01-01T00:00:00.000Z","kind":"directive","from":"x","pr":"111","command":"hold-p',
      // Adversarial constructions: a conflicting marker...
      '{"pr":"999","kind":"directive" garbage "kind":"note"}',
      // ...and a decoy `pr` token ahead of the real one.
      '{"pr":"111"} garbage {"pr":"999","kind":"directive"',
    ]) {
      writeFileSync(inboxPath(dir), `${bad}\n`);
      const r = foldGateState(dir, "999");
      expect(r.ok).toBe(false);
    }
  });

  it("a poisoned inbox recovers via repairInbox, never via automatic classification", async () => {
    writeFileSync(
      inboxPath(dir),
      '{"id":"m-1","ts":"2026-01-01T00:00:00.000Z","kind":"note","from":"x","pr":"999","body":"trunc\n',
    );
    expect(foldGateState(dir, "999").ok).toBe(false);
    await repairInbox(dir, false);
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    const r = foldGateState(dir, "999");
    if (!r.ok) throw new Error("repaired inbox must not stay poisoned");
    expect(r.state["hold-push"].active).toBe(true);
  });

  it("does NOT fail closed on a malformed (well-formed-JSON) directive stamped for a DIFFERENT PR", async () => {
    writeFileSync(
      inboxPath(dir),
      `${JSON.stringify({ id: "m-1", ts: new Date().toISOString(), kind: "directive", from: "x", pr: "111", command: "not-a-real-command" })}\n`,
    );
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    const r = foldGateState(dir, "999");
    if (!r.ok)
      throw new Error(
        "a malformed directive stamped for another PR must not poison this one — PR scoping must run before strict shape validation",
      );
    expect(r.state["hold-push"].active).toBe(true);
  });
});

describe("isPushHeld", () => {
  it("is not blocked against a clear (absent) mailbox", async () => {
    expect(isPushHeld(dir, "999")).toEqual({ blocked: false, reason: "" });
  });

  it("is blocked while hold-push is active, and names the directive", async () => {
    const msg = await appendDirective(dir, "999", "orchestrator", "hold-push");
    const r = isPushHeld(dir, "999");
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain(msg.id);
  });

  it("fails CLOSED — blocked — when the gate state cannot be determined", async () => {
    mkdirSync(inboxPath(dir));
    const r = isPushHeld(dir, "999");
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("could not be read");
  });

  it("is not blocked by pause or stop directives — only hold-push gates a push", async () => {
    await appendDirective(dir, "999", "orchestrator", "pause");
    await appendDirective(dir, "999", "orchestrator", "stop");
    expect(isPushHeld(dir, "999")).toEqual({ blocked: false, reason: "" });
  });
});

describe("appendDirective validation", () => {
  it("refuses a resume with no --target", async () => {
    await expect(appendDirective(dir, "999", "x", "resume")).rejects.toThrow(
      ExitError,
    );
  });

  it("refuses a non-resume directive carrying a target", async () => {
    await expect(
      appendDirective(dir, "999", "x", "hold-push", { target: "pause" }),
    ).rejects.toThrow(ExitError);
  });
});

describe("the line-size cap", () => {
  it("refuses a note whose body would break the single-write atomicity assumption", async () => {
    const huge = "x".repeat(8192);
    await expect(appendNote(dir, "999", "x", huge)).rejects.toThrow(ExitError);
  });
});

describe("appendLine durability (fsync after append)", () => {
  it("fsyncs the file after every append, not just a plain buffered write", async () => {
    // A plain `writeFileSync(path, content, {flag:'a'})` reports success once
    // the bytes reach the page cache, not stable storage -- on a crash
    // immediately after, a hold-push directive could be lost while
    // foldGateState reads the resulting file as CLEAR.
    const actualFs = await import("node:fs");
    const realFsyncSync = actualFs.fsyncSync;
    const realFs = { ...actualFs };
    let fsyncCalls = 0;
    mock.module("node:fs", () => ({
      ...realFs,
      fsyncSync: (fd: number) => {
        fsyncCalls += 1;
        return realFsyncSync(fd);
      },
    }));
    try {
      await appendNote(dir, "999", "orchestrator", "hello");
      expect(fsyncCalls).toBeGreaterThan(0);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("fsyncs the containing directory only when creating the mailbox file for the first time, not on every append", async () => {
    // The FILE's own fsync does not make the DIRECTORY ENTRY pointing at
    // it durable -- that only matters the first time inbox.jsonl is
    // created, not on a later append to an already-durable file.
    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realFs = { ...actualFs };
    let dirOpenCount = 0;
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        if (flags === "r" && path === dir) dirOpenCount += 1;
        return realOpenSync(path, flags);
      },
    }));
    try {
      await appendNote(dir, "999", "orchestrator", "first"); // creates inbox.jsonl
      expect(dirOpenCount).toBe(1);
      await appendNote(dir, "999", "orchestrator", "second"); // appends to an existing file
      expect(dirOpenCount).toBe(1); // unchanged — no repeated directory fsync
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("fsyncs every newly created ancestor directory, not just the immediate parent, when multiple levels are missing", async () => {
    // Fresh evidence beyond the single-level fix above: `mkdirSync`'s own
    // `recursive: true` can create MULTIPLE missing levels in one call
    // (mirroring `.context/drive-mailbox` both being absent on a fresh
    // worktree). Fsyncing only `dirname(path)` (the mailbox directory
    // itself) would leave its OWN entry — in ITS now-also-new parent —
    // undurable, so a power loss could discard the whole newly created
    // mailbox directory tree even though the file inside it was fsynced.
    const nestedContext = join(dir, "nested-context");
    const nestedMailbox = join(nestedContext, "drive-mailbox");
    expect(existsSync(nestedContext)).toBe(false);

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realFs = { ...actualFs };
    const fsyncedDirs = new Set<string>();
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        if (flags === "r") fsyncedDirs.add(path);
        return realOpenSync(path, flags);
      },
    }));

    try {
      await appendNote(nestedMailbox, "999", "orchestrator", "hello");
      // All three levels fsynced: the mailbox dir itself (the file's own
      // entry), its newly created parent (the mailbox dir's own entry),
      // and the PRE-EXISTING grandparent (the new parent's own entry).
      expect(fsyncedDirs.has(nestedMailbox)).toBe(true);
      expect(fsyncedDirs.has(nestedContext)).toBe(true);
      expect(fsyncedDirs.has(dir)).toBe(true);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("fsyncs the parent and grandparent unconditionally, even when THIS call's own mkdirSync reports nothing was created — closes the concurrent-first-sender race", async () => {
    // Simulates the concurrent-first-sender race: a CONCURRENT sender creates
    // the whole directory chain moments before this call's own mkdirSync runs
    // (so mkdirSync here legitimately returns `undefined` — the whole chain
    // already exists by the time THIS process calls it) — yet the
    // parent/grandparent directory entries are STILL newly created (by the
    // other sender) and still need fsyncing, which this process has no way to
    // know from its own mkdirSync return value alone. An earlier fix relied on
    // exactly that return value and would have fsynced only `nestedMailbox`
    // here, missing both ancestors.
    const nestedContext = join(dir, "raced-context");
    const nestedMailbox = join(nestedContext, "drive-mailbox");
    mkdirSync(nestedMailbox, { recursive: true }); // the "concurrent sender" already created it

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realFs = { ...actualFs };
    const fsyncedDirs = new Set<string>();
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        if (flags === "r") fsyncedDirs.add(path);
        return realOpenSync(path, flags);
      },
    }));

    try {
      await appendNote(nestedMailbox, "999", "orchestrator", "hello");
      expect(fsyncedDirs.has(nestedMailbox)).toBe(true);
      expect(fsyncedDirs.has(nestedContext)).toBe(true);
      expect(fsyncedDirs.has(dir)).toBe(true);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("flushes every ancestor created by a $DRIVE_PR_MAILBOX_DIR override deeper than the default two-level layout", async () => {
    // The fixed two-level floor (mailboxDir() === worktreeRoot/.context/
    // drive-mailbox) only bounds the DEFAULT production layout. Under the
    // test/operator override, `resolveMailboxDir()` permits an arbitrarily deep
    // path, and mkdirSync's own recursive create walks as far up as it needs to
    // — a chain missing MORE than two levels would leave the higher, still-new
    // ancestors unfsynced if the walk stopped at the fixed floor alone.
    const level1 = join(dir, "override-l1");
    const level2 = join(level1, "override-l2");
    const level3 = join(level2, "override-l3");
    const nestedMailbox = join(level3, "drive-mailbox");
    expect(existsSync(level1)).toBe(false);

    const actualFs = await import("node:fs");
    const realOpenSync = actualFs.openSync;
    const realFs = { ...actualFs };
    const fsyncedDirs = new Set<string>();
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (path: string, flags: string) => {
        if (flags === "r") fsyncedDirs.add(path);
        return realOpenSync(path, flags);
      },
    }));

    try {
      await appendNote(nestedMailbox, "999", "orchestrator", "hello");
      // Every level from the mailbox dir up through the pre-existing
      // `dir` is fsynced — four levels, past the fixed three-level floor.
      expect(fsyncedDirs.has(nestedMailbox)).toBe(true);
      expect(fsyncedDirs.has(level3)).toBe(true);
      expect(fsyncedDirs.has(level2)).toBe(true);
      expect(fsyncedDirs.has(level1)).toBe(true);
      expect(fsyncedDirs.has(dir)).toBe(true);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("cleans up a file it created when write/fsync/close then fails, so a retry correctly re-observes absent and re-runs the ancestor fsyncs", async () => {
    // Without cleanup, a failed FIRST append that already created the
    // file (openSync('a') creates transparently, whether or not the file
    // existed) leaves an empty/partial file behind. A later, otherwise-
    // successful retry would then observe existing.kind === 'ok' — not
    // 'absent' — setting fileIsNew false and skipping the ancestor-
    // directory fsyncs entirely, even though nobody has ever run them.
    const path = inboxPath(dir);

    const actualFs = await import("node:fs");
    const realWriteSync = actualFs.writeSync;
    const realFs = { ...actualFs };
    let failNextWrite = true;
    mock.module("node:fs", () => ({
      ...realFs,
      writeSync: (
        fd: number,
        buffer: Uint8Array,
        offset?: number,
        length?: number,
        position?: number | null,
      ) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("simulated ENOSPC mid-write");
        }
        return realWriteSync(fd, buffer, offset, length, position);
      },
    }));
    try {
      await expect(
        appendNote(dir, "999", "orchestrator", "first attempt"),
      ).rejects.toThrow("simulated ENOSPC mid-write");
      // The failed attempt's file must be cleaned up, restoring `absent`
      // for the next attempt to correctly re-observe.
      expect(existsSync(path)).toBe(false);
    } finally {
      mock.module("node:fs", () => realFs);
    }

    const realOpenSync = actualFs.openSync;
    const fsyncedDirs = new Set<string>();
    mock.module("node:fs", () => ({
      ...realFs,
      openSync: (p: string, flags: string) => {
        if (flags === "r") fsyncedDirs.add(p);
        return realOpenSync(p, flags);
      },
    }));
    try {
      await appendNote(dir, "999", "orchestrator", "retry");
      // The retry correctly re-observed `absent` (thanks to the cleanup
      // above) and ran the ancestor-directory fsync this time.
      expect(fsyncedDirs.has(dir)).toBe(true);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });
});

describe("repairInbox dry-run is genuinely read-only", () => {
  it("creates no .lock artifacts on a dry-run repair, even against an inbox with a dropped line", async () => {
    // Acquiring the mutating per-file lock on a dry-run broke the
    // command's own "reports without writing" contract: it creates
    // .lock.stale.*/.lock.recovering.stale.* tombstone directories as a
    // side effect and would fail outright against a genuinely read-only
    // mailbox directory.
    //
    // The inbox content is written DIRECTLY here (bypassing appendLine),
    // deliberately: appendLine's own lock acquire/release is itself a
    // normal source of these same tombstones (a known, separate property
    // of lock.ts, not this bug), and routing the setup through it would
    // make this test unable to tell "appendNote's own lock use" apart
    // from "repairInbox's dry-run taking one it shouldn't".
    writeFileSync(
      inboxPath(dir),
      `${JSON.stringify({ id: "m-1", ts: new Date().toISOString(), kind: "note", from: "x", pr: "999", body: "good" })}\n{"truncated-no-newline`,
    );
    const r = await repairInbox(dir, true);
    expect(r.ok).toBe(true);
    const lockArtifacts = readdirSync(dir).filter((e) => e.includes(".lock"));
    expect(lockArtifacts).toEqual([]);
  });
});

describe("appendLine self-healing (interrupted-write delimiter)", () => {
  it("inserts a leading newline before appending onto a file whose last line has no trailing newline", async () => {
    // Simulates an interrupted write: the file exists but its last byte is
    // not '\n' — as a truncated `write(2)` mid-append would leave it.
    writeFileSync(inboxPath(dir), '{"id":"m-bad","kind":"garbage-no-newline');
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    const raw = readFileSync(inboxPath(dir), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    // Two SEPARATE lines, not one glued blob — the whole point of the fix.
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"command":"hold-push"');
  });

  it("the appended directive is recoverable via repair — not permanently swallowed into the same unparsable line as the garbage prefix", async () => {
    // The exact failure mode the finding described: without delimiting, the
    // OLD undelimited append would glue a complete hold-push directive onto
    // a truncated note-shaped prefix, forming ONE combined unparsable line
    // that `repairInbox` would then drop WHOLESALE — losing the directive
    // permanently, with no way to recover it. With delimiting, the two stay
    // separate lines: the garbage still poisons (unconditionally, by
    // design — see foldGateState's own comment), but `repairInbox` now
    // drops only the isolated garbage line and the directive survives.
    writeFileSync(
      inboxPath(dir),
      '{"id":"m-bad","ts":"2026-01-01T00:00:00.000Z","kind":"note","from":"x","pr":"999","body":"trunc',
    );
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    expect(foldGateState(dir, "999").ok).toBe(false); // still poisoned — the garbage line itself

    const before = await repairInbox(dir, true);
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.droppedLines).toBe(1); // only the garbage — NOT the directive too

    await repairInbox(dir, false);
    const r = foldGateState(dir, "999");
    if (!r.ok)
      throw new Error(
        "the directive must survive repair intact, not have been dropped along with the garbage it was glued to",
      );
    expect(r.state["hold-push"].active).toBe(true);
  });

  it("does NOT insert a spurious newline when the file already ends cleanly", async () => {
    await appendNote(dir, "999", "orchestrator", "one");
    await appendNote(dir, "999", "orchestrator", "two");
    const raw = readFileSync(inboxPath(dir), "utf8");
    expect(raw.includes("\n\n")).toBe(false);
  });

  it("refuses to append onto an existing file whose tail cannot be read, rather than gluing onto it blind", async () => {
    // The self-healing predicate above only knows how to detect a missing
    // trailing newline when it can actually READ the existing tail. An
    // unreadable-but-appendable file (write-only permissions, a
    // transient read error, ...) is a case it cannot see into at all —
    // simulated here via `mock.module` (the same portability rationale as
    // `fsutil.test.ts`) rather than a real chmod, since this needs
    // writeFileSync to still succeed while only readFileSync fails, which
    // real permission bits don't cleanly isolate (and CI often runs as
    // root, which bypasses them entirely).
    const path = inboxPath(dir);
    const original =
      '{"id":"m-bad","ts":"2026-01-01T00:00:00.000Z","kind":"note","from":"x","pr":"999","body":"trunc';
    writeFileSync(path, original); // no trailing newline: a truncated tail

    const actualFs = await import("node:fs");
    const realReadFileSync = actualFs.readFileSync;
    const realFs = { ...actualFs };

    mock.module("node:fs", () => ({
      ...realFs,
      readFileSync: (p: string, enc: unknown) => {
        if (p === path) {
          const err = new Error(
            "simulated EACCES on read",
          ) as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return realReadFileSync(p, enc as never);
      },
    }));

    try {
      await expect(
        appendDirective(dir, "999", "orchestrator", "hold-push"),
      ).rejects.toThrow(ExitError);
      // Refused BEFORE writing anything — the truncated tail is untouched,
      // not glued to a directive it could not safely delimit.
      expect(realReadFileSync(path, "utf8")).toBe(original);
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });
});

describe("repairInbox", () => {
  it("reports zero drops against an absent inbox, without writing anything", async () => {
    const r = await repairInbox(dir, false);
    expect(r).toEqual({
      ok: true,
      path: inboxPath(dir),
      totalLines: 0,
      droppedLines: 0,
      dropped: [],
    });
  });

  it('fails CLOSED — not a false-empty "nothing to repair" — when the mailbox directory itself is inaccessible rather than absent', async () => {
    // `existsSync` collapses EVERY lookup error to `false`, not just
    // `ENOENT` — a directory that genuinely exists but cannot be looked
    // up (its own parent lacking search permission, say) reads
    // identically to "confirmed absent". Mocked here rather than a real
    // chmod, since permission bits behave inconsistently under CI (often
    // root, which bypasses them) — the same portability rationale
    // `fsutil.test.ts` documents for its own `mock.module` use.
    const actualFs = await import("node:fs");
    const realLstatSync = actualFs.lstatSync;
    const realFs = { ...actualFs };

    mock.module("node:fs", () => ({
      ...realFs,
      lstatSync: (p: string) => {
        if (p === dir) {
          const err = new Error(
            "simulated EACCES on directory lookup",
          ) as NodeJS.ErrnoException;
          err.code = "EACCES";
          throw err;
        }
        return realLstatSync(p);
      },
    }));

    try {
      const r = await repairInbox(dir, false);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.why).toContain("could not be inspected");
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("fails CLOSED, not a clean absent result, when the mailbox directory's own PARENT exists but is not a directory (ENOTDIR)", async () => {
    // The sibling of readMailboxFile's own ENOTDIR handling, at the directory
    // level rather than the file level: `lstatSync(dir)` raises ENOTDIR when
    // `dir`'s PARENT exists but is the wrong type (a regular file, not a
    // directory) — a broken location, never a genuinely absent one. This
    // module's own comment on the lstatSync call below claims it "mirrors
    // readMailboxFile's own absent/unreadable split so the two agree" — this
    // test is what keeps that claim true.
    const notADirectory = join(dir, "not-a-directory");
    writeFileSync(notADirectory, "this is a file, not a directory");
    const brokenMailboxDir = join(notADirectory, "drive-mailbox");
    const r = await repairInbox(brokenMailboxDir, false);
    expect(r.ok).toBe(false);
  });

  it("fails CLOSED on both dry-run and a real repair when the mailbox path itself exists as a regular FILE, not a directory", async () => {
    // `lstatSync(dir)` succeeding only proves SOMETHING exists at `dir` —
    // not that it's a directory. Before this fix, `dir` being a plain file
    // sailed past that check: the real (non-dry-run) path then reached
    // `lock.acquire()`, whose `mkdirSync(inbox.jsonl.lock)` fails with
    // ENOTDIR on every attempt (a path component, `dir` itself, is the
    // wrong type) — the lock treats that as ordinary contention and
    // eventually reports "another driver is updating state", sending an
    // operator chasing a nonexistent rival instead of the actual broken
    // path.
    const mailboxPathIsAFile = join(dir, "mailbox-is-actually-a-file");
    writeFileSync(mailboxPathIsAFile, "this is a file, not a directory");

    const dryResult = await repairInbox(mailboxPathIsAFile, true);
    expect(dryResult.ok).toBe(false);
    if (!dryResult.ok) expect(dryResult.why).toContain("not a directory");

    const realResult = await repairInbox(mailboxPathIsAFile, false);
    expect(realResult.ok).toBe(false);
    if (!realResult.ok) expect(realResult.why).toContain("not a directory");
  });

  it("succeeds through a mailbox directory reached via a SYMLINK, mirroring readMailboxFile which already reads through one", async () => {
    // The type check used to be `lstatSync(dir).isDirectory()`, which does
    // NOT follow a symlink — so a mailbox directory reached through one
    // reported `isDirectory() === false` and was rejected as "exists but
    // is not a directory", even though `readMailboxFile`'s own
    // `readFileSync` calls read straight through it without complaint.
    // `statSync` (which follows the link) is what the type check itself
    // must use; `lstatSync` still owns the earlier absent/unreadable split.
    const realDir = join(dir, "real-mailbox-dir");
    mkdirSync(realDir);
    const linkedDir = join(dir, "mailbox-via-symlink");
    symlinkSync(realDir, linkedDir);

    const dryResult = await repairInbox(linkedDir, true);
    expect(dryResult.ok).toBe(true);

    const realResult = await repairInbox(linkedDir, false);
    expect(realResult.ok).toBe(true);
  });

  it("succeeds on a mailbox directory that does not exist yet, and never creates it — repair as the very first mailbox command on a fresh worktree", async () => {
    // Every other test's `dir` is pre-created by `beforeEach`'s `mkdtempSync`,
    // which never exercises this: `createLock`'s own `mkdirSync(lock)` is not
    // recursive. Having repair create the mailbox directory itself before
    // locking would break `--dry-run`'s own "reports without writing" contract
    // by mutating a fresh worktree unconditionally, so repair short-circuits on
    // an absent directory before touching the filesystem at all, for both
    // dry-run and a real repair.
    const freshDir = join(dir, "never-created-yet");
    expect(existsSync(freshDir)).toBe(false);

    const dryResult = await repairInbox(freshDir, true);
    expect(dryResult).toEqual({
      ok: true,
      path: inboxPath(freshDir),
      totalLines: 0,
      droppedLines: 0,
      dropped: [],
    });
    expect(existsSync(freshDir)).toBe(false); // dry-run created nothing

    const r = await repairInbox(freshDir, false);
    expect(r).toEqual({
      ok: true,
      path: inboxPath(freshDir),
      totalLines: 0,
      droppedLines: 0,
      dropped: [],
    });
    expect(existsSync(freshDir)).toBe(false); // still absent: nothing to repair, nothing to create
  });

  it("reports an explicit failure — not a clean zero-drop result — against an unreadable inbox", async () => {
    mkdirSync(inboxPath(dir)); // a directory, not a file — 'unreadable'
    const r = await repairInbox(dir, false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("could not be read");
  });

  it("drops only the line JSON.parse rejects, keeping every line that parses regardless of shape", async () => {
    await appendNote(dir, "999", "orchestrator", "good one");
    // A well-formed-JSON but shape-invalid directive — must SURVIVE repair,
    // since only unparsable lines are the interrupted-write artifact this
    // exists to clear (a human should see a malformed real directive).
    appendFileSync(
      inboxPath(dir),
      `${JSON.stringify({ id: "m-2", ts: new Date().toISOString(), kind: "directive", from: "x", pr: "999", command: "not-a-real-command" })}\n`,
    );
    appendFileSync(
      inboxPath(dir),
      '{"id":"m-bad","ts":"2026-01-01T00:00:00.000Z","kind":"note","from":"x","pr":"999","body":"trunc', // no trailing newline: truncated tail
    );
    const before = await repairInbox(dir, true);
    expect(before.ok).toBe(true);
    if (before.ok) {
      expect(before.totalLines).toBe(3);
      expect(before.droppedLines).toBe(1);
    }

    const after = await repairInbox(dir, false);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.droppedLines).toBe(1);

    // The gate is no longer poisoned by the unparsable tail — but the
    // malformed-but-parseable directive survived repair and still poisons
    // the fold on its OWN merits, which is the intended behaviour.
    const r = foldGateState(dir, "999");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toContain("not-a-real-command");
  });

  it("preserves a record appended between its two reads, rather than discarding it", async () => {
    // `appendedSince` is unit-tested as a pure function below, but nothing
    // exercised the INTEGRATION that consumes it: `repairInbox`'s own
    // `kept.map(...).join('') + suffix` concatenation, only reached when
    // `dropped.length > 0`. Every other repair test here runs with no writer
    // between the two reads, so `suffix` is always empty and a bug in the
    // concatenation itself — dropped, or ordered before `kept` — would pass
    // every one of them silently.
    const path = inboxPath(dir);
    await appendNote(dir, "999", "orchestrator", "original");
    appendFileSync(path, '{"truncated-tail-no-newline'); // the line repair drops

    const actualFs = await import("node:fs");
    const realReadFileSync = actualFs.readFileSync;
    const realFs = { ...actualFs };

    // Append a valid directive on the SECOND read only, so `appendedSince`
    // returns a real suffix that must survive the rewrite.
    let reads = 0;
    const injected = `${JSON.stringify({
      id: "m-late",
      ts: "2026-01-01T00:00:00.000Z",
      kind: "directive",
      from: "racer",
      pr: "999",
      command: "hold-push",
    })}\n`;
    mock.module("node:fs", () => ({
      ...realFs,
      readFileSync: (p: string, enc: unknown) => {
        const raw = realReadFileSync(p, enc as never);
        if (p === path && ++reads === 1) {
          // after the first read returns, land the concurrent append
          appendFileSync(path, `\n${injected}`);
        }
        return raw;
      },
    }));

    try {
      const r = await repairInbox(dir, false);
      expect(r.ok).toBe(true);
      const raw = realReadFileSync(path, "utf8") as string;
      expect(raw).toContain("m-late");
      expect(raw).not.toContain("truncated-tail-no-newline");
    } finally {
      mock.module("node:fs", () => realFs);
    }
  });

  it("a repaired inbox recovers once the poisoning line is removed — mutation-sensitive: fails without the repairInbox call", async () => {
    // Genuinely poisons on its own: a complete "kind":"directive" token with
    // no readable `pr`, so nothing in the heuristic can wave it through.
    appendFileSync(
      inboxPath(dir),
      '{"id":"m-bad","ts":"2026-01-01T00:00:00.000Z","kind":"directive","from":"x","command":"hold-p',
    );
    expect(foldGateState(dir, "999").ok).toBe(false); // poisoned BEFORE repair

    await repairInbox(dir, false);
    await appendDirective(dir, "999", "orchestrator", "hold-push");
    const r = foldGateState(dir, "999");
    if (!r.ok) throw new Error("repaired inbox must not stay poisoned");
    expect(r.state["hold-push"].active).toBe(true);
  });
});

describe("appendedSince", () => {
  it("is empty when nothing was appended", async () => {
    expect(appendedSince("a\nb\n", "a\nb\n")).toBe("");
  });

  it("returns exactly the bytes appended after the first read", async () => {
    expect(appendedSince("a\nb\n", "a\nb\nc\n")).toBe("c\n");
  });

  it("is empty when the file was replaced rather than extended — out of scope for this guard", async () => {
    expect(appendedSince("a\nb\n", "x\ny\n")).toBe("");
  });

  it("is empty when the file shrank (e.g. a concurrent repair already ran)", async () => {
    expect(appendedSince("a\nb\nc\n", "a\n")).toBe("");
  });
});

describe("concurrent senders (real processes, not same-process promises)", () => {
  // The unit tests above exercise the lock through same-process `await`s, which
  // never actually contends it — this is the test that does: many REAL,
  // independent `mailbox.ts send` processes racing the same inbox file,
  // verifying the lock actually serializes them rather than merely looking
  // correct in a single-threaded harness.
  it("every concurrent sender lands a complete, individually-parseable line — none glued, none lost", async () => {
    const mailboxScript = join(import.meta.dir, "..", "scripts", "mailbox.ts");
    const COUNT = 12;
    const procs = Array.from({ length: COUNT }, (_, i) =>
      Bun.spawn(
        [
          "bun",
          mailboxScript,
          "send",
          "999",
          "--kind",
          "note",
          "--from",
          `sender-${i}`,
          "--body",
          `concurrent message ${i}`,
        ],
        {
          env: { ...process.env, DRIVE_PR_MAILBOX_DIR: dir },
          stdout: "ignore",
          stderr: "pipe",
        },
      ),
    );
    const results = await Promise.all(
      procs.map(async (p) => ({
        exitCode: await p.exited,
        stderr: await new Response(p.stderr).text(),
      })),
    );
    for (const r of results) {
      if (r.exitCode !== 0) throw new Error(`sender failed: ${r.stderr}`);
    }

    const raw = readFileSync(inboxPath(dir), "utf8");
    const lines = raw.split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(COUNT);
    // Every line must be independently valid JSON — a glued/corrupted line
    // from an unlocked race would fail this.
    const bodies = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line);
      bodies.add(parsed.body);
    }
    expect(bodies.size).toBe(COUNT);

    const r = okMessages(dir, "999");
    expect(r.messages).toHaveLength(COUNT);
    expect(r.warnings).toEqual([]);
  }, 20_000);
});

describe("mailbox.ts ack CLI validation", () => {
  const mailboxScript = join(import.meta.dir, "..", "scripts", "mailbox.ts");
  function runAck(args: string[]) {
    return Bun.spawn(["bun", mailboxScript, "ack", "999", ...args], {
      env: { ...process.env, DRIVE_PR_MAILBOX_DIR: dir },
      stdout: "ignore",
      stderr: "pipe",
    });
  }
  function runRespond(args: string[]) {
    return Bun.spawn(["bun", mailboxScript, "respond", "999", ...args], {
      env: { ...process.env, DRIVE_PR_MAILBOX_DIR: dir },
      stdout: "ignore",
      stderr: "pipe",
    });
  }

  it("refuses an empty --id rather than silently writing an unusable ack record", async () => {
    // An empty `--id ''` (e.g. an unset shell variable) previously passed
    // the "at least one --id" count check and reached
    // appendOutboxRecord, writing a record `parseOutboxRecord` later
    // rejects for having a non-empty-string id — the command reported
    // success while the ack never actually took effect.
    const p = runAck(["--id", ""]);
    const [exitCode, stderr] = await Promise.all([
      p.exited,
      new Response(p.stderr).text(),
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("must not be empty");
    // Nothing was written at all — not even for a later valid id in the
    // same call, since validation runs before any append.
    expect(existsSync(outboxPath(dir))).toBe(false);
  });

  it("refuses the WHOLE batch when any one --id among several is empty, writing none of them", async () => {
    const p = runAck(["--id", "m-good", "--id", ""]);
    const [exitCode] = await Promise.all([p.exited, p.stderr]);
    expect(exitCode).toBe(2);
    expect(existsSync(outboxPath(dir))).toBe(false);
  });

  it("accepts a real inbox message id normally", async () => {
    const msg = await appendNote(dir, "999", "orchestrator", "hello");
    const p = runAck(["--id", msg.id]);
    const [exitCode, stderr] = await Promise.all([
      p.exited,
      new Response(p.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`ack failed: ${stderr}`);
    const raw = readFileSync(outboxPath(dir), "utf8");
    expect(raw).toContain(`"id":"${msg.id}"`);
  });

  it("refuses an id that is not a known inbox message — a typo, not a real ack", async () => {
    // A typo'd id, or a following flag mistakenly consumed as an id's value,
    // previously durably wrote an outbox record for an id naming NO real inbox
    // message — the command reported success while the message actually
    // intended stayed unseen forever.
    await appendNote(dir, "999", "orchestrator", "hello");
    const p = runAck(["--id", "m-typo-does-not-exist"]);
    const [exitCode, stderr] = await Promise.all([
      p.exited,
      new Response(p.stderr).text(),
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("not a known inbox message");
    expect(existsSync(outboxPath(dir))).toBe(false);
  });

  it("allows re-acking an id already acknowledged or already responded to — not a typo, a legitimate re-send", async () => {
    // Validating against every KNOWN inbox message (not just the
    // currently-unseen subset) is deliberate: unseenMessages() removes an
    // id from its results the instant it has ANY outbox record, so
    // validating against that instead would make the intended
    // ack-then-respond sequence — or a harmless re-ack — fail as though
    // the id were a typo.
    const msg = await appendNote(dir, "999", "orchestrator", "hello");
    const first = runAck(["--id", msg.id]);
    if ((await first.exited) !== 0) throw new Error("first ack failed");
    const second = runAck(["--id", msg.id]); // re-ack the same id
    await expectSpawnExited(second, 0);

    const respond = runRespond(["--id", msg.id, "--response", "done"]);
    const [respondExit, respondStderr] = await Promise.all([
      respond.exited,
      new Response(respond.stderr).text(),
    ]);
    if (respondExit !== 0)
      throw new Error(`respond after ack failed: ${respondStderr}`);
  });

  it("respond refuses an id that is not a known inbox message, the same as ack does", async () => {
    await appendNote(dir, "999", "orchestrator", "hello");
    const p = runRespond([
      "--id",
      "m-typo-does-not-exist",
      "--response",
      "done",
    ]);
    const [exitCode, stderr] = await Promise.all([
      p.exited,
      new Response(p.stderr).text(),
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("not a known inbox message");
    expect(existsSync(outboxPath(dir))).toBe(false);
  });
});

describe("mailbox.ts send CLI validation", () => {
  const mailboxScript = join(import.meta.dir, "..", "scripts", "mailbox.ts");

  it("refuses PR '0' at the CLI, before it can ever reach a stored directive `isCanonicalPr` would fail the fold on", async () => {
    // `resolvePrArg` accepted '0' (it is `isDigits` and its own
    // `BigInt(...).toString()`) even though `isCanonicalPr` in
    // lib/state/mailbox.ts already rejects it — `!isCanonicalPr(msg.pr)`
    // makes `foldGateState` fail CLOSED (poison the fold), it does not
    // silently skip. This CLI-side check is defense in depth: a rejected
    // `send 0 ...` never gets to write the directive at all, so no later
    // fold for any real PR is ever put in the poisoned state in the first
    // place.
    const p = Bun.spawn(
      [
        "bun",
        mailboxScript,
        "send",
        "0",
        "--kind",
        "directive",
        "--from",
        "orchestrator",
        "--command",
        "hold-push",
      ],
      {
        env: { ...process.env, DRIVE_PR_MAILBOX_DIR: dir },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      p.exited,
      new Response(p.stderr).text(),
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("non-zero");
    expect(existsSync(inboxPath(dir))).toBe(false);
  });

  it("refuses '--kind note' combined with '--command', instead of silently discarding the directive-only flag and writing a plain note", async () => {
    // `command`/`target` were parsed unconditionally but only READ by the
    // directive branch — a contradictory `--kind note --command hold-push`
    // used to write a plain note and exit 0, with no complaint. An operator
    // making that mistake could believe a hold was installed while
    // `guarded-push.ts` remained clear and proceeded to push.
    const p = Bun.spawn(
      [
        "bun",
        mailboxScript,
        "send",
        "999",
        "--kind",
        "note",
        "--from",
        "orchestrator",
        "--body",
        "hello",
        "--command",
        "hold-push",
      ],
      {
        env: { ...process.env, DRIVE_PR_MAILBOX_DIR: dir },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      p.exited,
      new Response(p.stderr).text(),
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--command is only valid with --kind directive");
    expect(existsSync(inboxPath(dir))).toBe(false);
  });

  it("refuses '--kind note' combined with '--target', the same as '--command'", async () => {
    const p = Bun.spawn(
      [
        "bun",
        mailboxScript,
        "send",
        "999",
        "--kind",
        "note",
        "--from",
        "orchestrator",
        "--body",
        "hello",
        "--target",
        "pause",
      ],
      {
        env: { ...process.env, DRIVE_PR_MAILBOX_DIR: dir },
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      p.exited,
      new Response(p.stderr).text(),
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--target is only valid with --kind directive");
    expect(existsSync(inboxPath(dir))).toBe(false);
  });
});
