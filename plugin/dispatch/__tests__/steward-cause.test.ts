/**
 * The steward's `cause` record and the wrapper's own report: a pass whose
 * end the wrapper explains is recorded `by: wrapper` (a steward pass always,
 * with the cause it saw, else `unknown`), a pickup's or a follow-up's pass
 * it cannot explain keeps `by: none` with its transcript copied, and is put
 * to the steward, whose cause the next tick records `by: steward`, redacted,
 * never over a report the run's own writer recorded.
 */
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkClosingReport,
  type ClosingReport,
} from "../../shared/closing-report.ts";
import type { ApplyState } from "../lib/actions/launch.ts";
import { recordReport } from "../lib/closing-report-store.ts";
import { settleUnreported, wrapperReport } from "../lib/end-report.ts";
import {
  type LaunchRecord,
  type ReadRecord,
  readEnded,
  recordExit,
  writeRecord,
} from "../lib/launches.ts";
import { insertRow, readRows, type EndedRow } from "../lib/log.ts";
import { closeStateDb, stateDb } from "../lib/state.ts";
import {
  checkedRecords,
  eraseStewardOutput,
  keepStewardRun,
  readStewardDigest,
  recordBelongsToDigest,
  stewardRecords,
  submitStewardRecords,
  type StewardDigest,
} from "../lib/steward.ts";
import {
  applyStewardCause,
  causeMembers,
  UNREPORTED_LIMIT,
  unreportedRuns,
} from "../lib/steward-causes.ts";
import type { RepoObservation } from "../lib/tick-observe.ts";
import { CAUSE_RECORDED, readTranscriptCopy } from "../lib/transcript-copy.ts";

const roots: string[] = [];
afterAll(() => {
  closeStateDb();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "steward-cause-"));
  roots.push(root);
  return root;
}

const SLUG = "example-org/example-repo";
const SESSION = "0b6f2a1e-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

function launch(
  root: string,
  n: number,
  fields: Partial<LaunchRecord> = {},
): LaunchRecord {
  const record: LaunchRecord = {
    version: 1,
    id: `20261114T10130${n}Z-3${n}c6fa5f`,
    token: `token-${n}-abcdef`,
    action: "followup",
    repo: SLUG,
    repoPath: "/repo",
    pr: 9,
    item: null,
    account: "a",
    vendor: "claude",
    configDir: join(root, "config"),
    wallBackoffMs: 3_600_000,
    replaces: null,
    facts: "",
    createdAt: `2026-11-14T10:13:0${n}.000Z`,
    workspace: null,
    attempts: [],
    agentId: null,
    model: null,
    effort: null,
    released: false,
    command: "/followup",
    marker: null,
    sessionId: SESSION,
    passTimeoutSec: 900,
    ...fields,
  };
  writeRecord(record, root);
  return record;
}

/** End `record` with exit 1 and write its ended row, `by: none`, at `at`. */
function ended(root: string, record: LaunchRecord, at: string): ReadRecord {
  recordExit(
    record.id,
    { at, code: 1, signal: null, context: "Error: secret=hunter2 at step 3" },
    root,
  );
  writeRecord({ ...record, endedAt: at }, root);
  const row: EndedRow = {
    kind: "ended",
    key: `ended ${record.id}`,
    at,
    repo: SLUG,
    stage: record.action,
    target: "PR #9",
    record: record.id,
    account: "a",
    model: null,
    durationMs: 0,
    rounds: null,
    class: "unknown",
    reason: "exit 1",
    by: "none",
  };
  insertRow(stateDb(root), row);
  const r = readEnded(record.id, root);
  if (r === null) throw new TypeError("the record did not end");
  return r;
}

function transcript(root: string): void {
  const dir = join(root, "config", "projects", "-repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${SESSION}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Ran the tests; 2 failed." }],
      },
    })}\n`,
  );
}

const valid = (report: ClosingReport | null) => {
  expect(report).not.toBeNull();
  expect(checkClosingReport(report)).toEqual([]);
  return report as ClosingReport;
};

describe("the wrapper's report of an end it explains", () => {
  const record = { action: "followup" as const, passTimeoutSec: 900 };

  it("records a pass that could not start, and one it stopped at its deadline", () => {
    const seen = { code: 1, signal: null };
    expect(
      valid(wrapperReport(record, { ...seen, startup: "unstarted" })).cause,
    ).toBe("startup");
    expect(
      valid(wrapperReport(record, { ...seen, startup: "quota" })).cause,
    ).toBe("usage-limit");
    const deadline = valid(
      wrapperReport(record, { code: null, signal: "SIGTERM", timedOut: true }),
    );
    expect(deadline.cause).toBe("deadline");
    expect(deadline.concluded).toContain("900-second deadline");
  });

  it("records nothing for a pickup or follow-up end it cannot explain, nor for a drive", () => {
    expect(wrapperReport(record, { code: 1, signal: null })).toBeNull();
    expect(wrapperReport(record, null)).toBeNull();
    expect(
      wrapperReport({ action: "rearm", passTimeoutSec: 900 }, null),
    ).toBeNull();
  });

  it("records every steward pass that left no report, with the cause it saw, else unknown", () => {
    const steward = { action: "steward" as const, passTimeoutSec: 900 };
    const plain = valid(wrapperReport(steward, { code: 1, signal: null }));
    expect(plain.cause).toBe("unknown");
    expect(plain.concluded).toContain("submitted no records");
    expect(
      valid(
        wrapperReport(steward, {
          code: 1,
          signal: null,
          output: "You've hit your limit · resets 5pm",
        }),
      ).cause,
    ).toBe("usage-limit");
    expect(valid(wrapperReport(steward, null, true)).concluded).toContain(
      "submitted its records",
    );
  });
});

describe("settling a pass that left no report", () => {
  it("copies an unexplained follow-up's transcript and records no report", () => {
    const root = scratch();
    transcript(root);
    const record = launch(root, 1);
    settleUnreported(record, { code: 1, signal: null }, SESSION, root);
    expect(readEnded(record.id, root)).toBeNull();
    expect(readTranscriptCopy(record.id, root)?.transcript).not.toBeNull();
    const kept = stateDb(root)
      .query("SELECT report FROM launches WHERE id = ?")
      .get(record.id) as { report: string | null };
    expect(kept.report).toBeNull();
  });

  it("records the steward's own end by wrapper, and never replaces a report the run recorded", () => {
    const root = scratch();
    const steward = launch(root, 2, { action: "steward", pr: null });
    settleUnreported(steward, { code: 1, signal: null }, SESSION, root);
    recordExit(
      steward.id,
      { at: "2026-11-14T10:20:00.000Z", code: 1, signal: null },
      root,
    );
    expect(readEnded(steward.id, root)?.report).toMatchObject({
      by: "wrapper",
      report: { cause: "unknown" },
    });
    const reported = launch(root, 3, { action: "steward", pr: null });
    const own: ClosingReport = {
      schema: "closing-report/v1",
      concluded: "Submitted two records.",
      suggested_next: { step: "Apply them.", owner: "line" },
    };
    recordReport(reported.id, own, "agent", root);
    settleUnreported(
      reported,
      { code: 0, signal: null, timedOut: true },
      SESSION,
      root,
    );
    recordExit(
      reported.id,
      { at: "2026-11-14T10:20:00.000Z", code: 0, signal: null },
      root,
    );
    expect(readEnded(reported.id, root)?.report).toMatchObject({
      by: "agent",
      report: own,
    });
    expect(readTranscriptCopy(reported.id, root)).toBeNull();
  });
});

describe("the steward's cause record", () => {
  const record = {
    kind: "cause",
    record: "20261114T101301Z-31c6fa5f",
    cause: "tool-failed",
    summary: "It ran the tests and two failed.",
    reason: "the excerpt ends on two test failures",
  };

  it("takes a cause of the steward's own from the closed list and a summary of at most 600 characters", () => {
    expect(checkedRecords([record]).ok).toBe(true);
    for (const bad of [
      { ...record, cause: "deadline" },
      { ...record, cause: "startup" },
      { ...record, summary: "x".repeat(601) },
      { ...record, summary: "" },
      { ...record, reason: "" },
      { ...record, extra: true },
    ])
      expect(checkedRecords([bad]).ok).toBe(false);
  });

  it("names only a run its own digest lists", () => {
    const digest = {
      version: 1,
      repo: SLUG,
      drives: [],
      needs: [],
      queue: [],
      passes: [],
      failures: [],
      load: null,
      unreported: [{ record: record.record }],
    } as unknown as StewardDigest;
    const checked = checkedRecords([record]);
    if (!checked.ok || checked.value[0]?.kind !== "cause")
      throw new TypeError("the cause record did not check");
    const cause = checked.value[0];
    expect(recordBelongsToDigest(cause, digest)).toBe(true);
    expect(recordBelongsToDigest({ ...cause, record: "other" }, digest)).toBe(
      false,
    );
  });
});

/** Runs without a report, each examined for a copy, and two that are not put to the steward. */
function unreportedWorld(root: string): ReadRecord[] {
  transcript(root);
  const runs: ReadRecord[] = [];
  for (let n = 1; n <= UNREPORTED_LIMIT + 1; n++) {
    const r = launch(root, n);
    settleUnreported(r, { code: 1, signal: null }, SESSION, root);
    runs.push(ended(root, r, `2026-11-14T11:0${n}:00.000Z`));
  }
  const steward = launch(root, 8, { action: "steward", pr: null });
  settleUnreported(steward, { code: 1, signal: null }, SESSION, root);
  runs.push(ended(root, steward, "2026-11-14T11:30:00.000Z"));
  // A run the host never examined for a copy, such as one an earlier release ended.
  runs.push(ended(root, launch(root, 9), "2026-11-14T11:40:00.000Z"));
  return runs;
}

describe("runs without a report in the steward's backlog and digest", () => {
  it("lists the latest examined pickups and follow-ups no pass judged, at most the limit, with their excerpts", () => {
    const root = scratch();
    const runs = unreportedWorld(root);
    const members = causeMembers(runs, SLUG, new Set(), root);
    expect(members).toHaveLength(UNREPORTED_LIMIT);
    expect(members.map((m) => m.target)).toEqual(
      runs
        .slice(1, UNREPORTED_LIMIT + 1)
        .map((r) => r.record.id)
        .reverse(),
    );
    const judged = new Set([JSON.stringify(["cause", members[0]?.target, ""])]);
    expect(
      causeMembers(runs, SLUG, judged, root).map((m) => m.target),
    ).toContain(String(runs[0]?.record.id));
    const [entry] = unreportedRuns(runs, members, root);
    expect(entry).toMatchObject({
      action: "followup",
      target: "PR #9",
      exit: { code: 1, signal: null },
      excerpt: { untrusted: true, assistant: ["Ran the tests; 2 failed."] },
      output: { untrusted: true },
    });
    expect(JSON.stringify(entry?.output)).not.toContain("hunter2");
  });

  it("erases the excerpts and output tails of a digest past the retention", () => {
    const root = scratch();
    const runs = unreportedWorld(root);
    const members = causeMembers(runs, SLUG, new Set(), root);
    keepStewardRun(
      "old-run",
      {
        version: 1,
        repo: SLUG,
        drives: [],
        needs: [],
        queue: [],
        passes: [],
        failures: [],
        load: null,
        unreported: unreportedRuns(runs, members, root),
      },
      0,
      root,
    );
    expect(eraseStewardOutput(31 * 86_400_000, 30, root)).toBe(1);
    const digest = readStewardDigest("old-run", root);
    if (!digest.ok) throw new TypeError("the digest did not read");
    expect(JSON.stringify(digest.value)).not.toContain("2 failed");
    expect(digest.value.unreported?.[0]).toMatchObject({
      excerpt: { unavailable: "erased after the retention period" },
      output: null,
    });
  });
});

/** The next tick's application of one cause record submitted for `run`'s digest. */
function apply(
  root: string,
  records: ReadRecord[],
  cause: Record<string, unknown>,
): { effect: string | null; unplaced: unknown[] } {
  const members = causeMembers(records, SLUG, new Set(), root);
  keepStewardRun(
    "run",
    {
      version: 1,
      repo: SLUG,
      drives: [],
      needs: [],
      queue: [],
      passes: [],
      failures: [],
      load: null,
      unreported: unreportedRuns(records, members, root),
    },
    0,
    root,
  );
  expect(submitStewardRecords("run", [cause], root).ok).toBe(true);
  const [kept] = stewardRecords(SLUG, root);
  if (kept?.value.kind !== "cause") throw new TypeError("no cause record");
  const unplaced: unknown[] = [];
  const state = { root, records } as unknown as ApplyState;
  const observation = {
    opened: { repo: { slug: SLUG }, report: { unplaced } },
  } as unknown as RepoObservation;
  applyStewardCause(state, observation, kept, kept.value);
  const [after] = stewardRecords(SLUG, root);
  return { effect: after?.effect ?? null, unplaced };
}

describe("applying a cause", () => {
  it("records it on the run's row, by steward, with its summary redacted as its concluded", () => {
    const root = scratch();
    const runs = unreportedWorld(root);
    const target = runs[UNREPORTED_LIMIT] as ReadRecord;
    const done = apply(root, runs, {
      kind: "cause",
      record: target.record.id,
      cause: "tool-failed",
      summary: `It ran the tests with ${target.record.token} and mailed me@example.com; two failed.`,
      reason: "the excerpt ends on two test failures",
    });
    expect(done).toEqual({ effect: CAUSE_RECORDED, unplaced: [] });
    const row = readRows(undefined, undefined, root).find(
      (r): r is EndedRow => r.kind === "ended" && r.record === target.record.id,
    );
    expect(row).toMatchObject({ by: "steward", cause: "tool-failed" });
    expect(row?.concluded).toContain("<redacted>");
    expect(row?.concluded).not.toContain(target.record.token);
    expect(row?.concluded).not.toContain("me@example.com");
    const columns = stateDb(root)
      .query("SELECT cause, report_by FROM log WHERE key = ?")
      .get(`ended ${target.record.id}`);
    expect(columns).toEqual({ cause: "tool-failed", report_by: "steward" });
  });

  it("is refused for a run that already holds a report, and for one that is not a pickup's or a follow-up's", () => {
    const root = scratch();
    const runs = unreportedWorld(root);
    const target = runs[UNREPORTED_LIMIT] as ReadRecord;
    recordReport(
      target.record.id,
      {
        schema: "closing-report/v1",
        concluded: "Recorded late.",
        suggested_next: { step: "None.", owner: "none" },
      },
      "agent",
      root,
    );
    const late = apply(root, runs, {
      kind: "cause",
      record: target.record.id,
      cause: "crashed",
      summary: "It crashed.",
      reason: "the excerpt stops mid-turn",
    });
    expect(late.effect).toBe("refused");
    expect(readEnded(target.record.id, root)?.report?.by).toBe("agent");
  });
});
