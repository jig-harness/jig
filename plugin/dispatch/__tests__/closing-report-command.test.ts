/**
 * `jig dispatch report <record> <token> <file>`: a pass writes its closing
 * report, before or after its result and more than once, the last that
 * passes the check standing; a refused report names what is wrong and
 * records nothing; no report touches the result. The launch record keeps it
 * whole and the outcome log's ended row carries its fields, with `cause` and
 * `by` as columns.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { readEnded, readResult, recordExit } from "../lib/launches.ts";
import { logEnded } from "../lib/log-ended.ts";
import { exportLog } from "../lib/log-export.ts";
import { type EndedRow, readRows } from "../lib/log.ts";
import { stateDb } from "../lib/state.ts";
import { world, type World } from "./fixtures.ts";
import { dispatchState, earlierRecord } from "./launch-fixtures.ts";

const ID = "20261114T101301Z-33c6fa5f";
const QUESTION = "Should the export keep the old column?";

const DECISION = {
  schema: "parked-decision/v1",
  class: "scope",
  call: {
    id: "a",
    question: QUESTION,
    options: [
      { id: "keep", name: "Keep it", summary: "It stays.", pay: ["Width."] },
      { id: "drop", name: "Drop it", summary: "It goes.", pay: ["Breaks."] },
    ],
    recommended: "keep",
    why: "Readers of the column still exist.",
  },
  steps: [],
  alreadyDone: "The scouts ran.",
};

const REPORT = {
  schema: "closing-report/v1",
  concluded: "Opened #812 for the item; its drive is armed.",
  suggested_next: { step: "Drive #812 to convergence.", owner: "line" },
  evidence: ["pr:#812"],
};

const SHORT = {
  schema: "closing-report/v1",
  concluded: "Stopped: the item asks for a schema the repository lacks.",
  question: QUESTION,
  decision: DECISION,
  suggested_next: {
    step: "Choose whether the column stays.",
    owner: "person",
    act: "Decide",
  },
  cause: "needs-person",
};

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function fixture(
  action: "pickup" | "followup" | "steward" | "rearm" = "pickup",
): World {
  const w = world();
  current = w;
  earlierRecord(w, {
    id: ID,
    account: "a",
    action,
    ...(action === "pickup"
      ? { item: "#12", pr: null }
      : action === "steward"
        ? { item: null, pr: null }
        : { pr: 12 }),
  });
  return w;
}

let files = 0;
function reportFile(w: World, value: unknown): string {
  const path = join(w.root, `report-${files++}.json`);
  writeFileSync(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return path;
}

const report = (w: World, value: unknown, token = "earlier-token") =>
  w.dispatch(["report", ID, token, reportFile(w, value)]);

function ended(w: World): EndedRow[] {
  return readRows(undefined, undefined, dispatchState(w)).filter(
    (r): r is EndedRow => r.kind === "ended",
  );
}

function columns(w: World): { cause: string | null; report_by: string | null } {
  return stateDb(dispatchState(w))
    .query("SELECT cause, report_by FROM log WHERE key = ?")
    .get(`ended ${ID}`) as { cause: string | null; report_by: string | null };
}

async function endAndLog(w: World): Promise<void> {
  const root = dispatchState(w);
  recordExit(
    ID,
    { at: "2026-11-14T10:20:00.000Z", code: 0, signal: null },
    root,
  );
  const snapshot = readEnded(ID, root);
  if (snapshot === null) throw new TypeError("missing fixture launch");
  expect(
    await logEnded([snapshot], {
      all: [snapshot],
      drives: [],
      merged: async () => null,
      nowIso: "2026-11-14T10:21:00.000Z",
      root,
    }),
  ).toEqual([]);
}

describe("jig dispatch report", () => {
  it("keeps the report on the record and its fields on the ended row, with cause and by as columns", async () => {
    const w = fixture();
    const ran = await report(w, SHORT);
    expectSpawnExit(ran, 0);
    expect(JSON.parse(ran.stdout)).toEqual({
      record: ID,
      item: "#12",
      report: "recorded",
      by: "agent",
      cause: "needs-person",
    });
    await endAndLog(w);
    expect(readEnded(ID, dispatchState(w))?.report).toMatchObject({
      by: "agent",
      report: SHORT,
    });
    const [row] = ended(w);
    expect(row).toMatchObject({
      by: "agent",
      concluded: SHORT.concluded,
      question: QUESTION,
      decision: DECISION,
      suggested_next: SHORT.suggested_next,
      cause: "needs-person",
    });
    expect(row?.next).toBeDefined();
    expect(columns(w)).toEqual({ cause: "needs-person", report_by: "agent" });
  });

  it("writes by none on the row of a run that left no report, and a late report refreshes it", async () => {
    const w = fixture("followup");
    await endAndLog(w);
    expect(ended(w)[0]?.by).toBe("none");
    expect(ended(w)[0]?.concluded).toBeUndefined();
    expect(columns(w)).toEqual({ cause: null, report_by: "none" });
    expectSpawnExit(await report(w, SHORT), 0);
    expect(ended(w)[0]).toMatchObject({
      by: "agent",
      cause: "needs-person",
      question: QUESTION,
    });
    expect(columns(w)).toEqual({ cause: "needs-person", report_by: "agent" });
    // A later report replaces the earlier one's fields on the row.
    expectSpawnExit(await report(w, REPORT), 0);
    const [row] = ended(w);
    expect(row?.concluded).toBe(REPORT.concluded);
    expect(row?.question).toBeUndefined();
    expect(row?.decision).toBeUndefined();
    expect(row?.cause).toBeUndefined();
    expect(columns(w)).toEqual({ cause: null, report_by: "agent" });
  });

  it("refreshes the exported line of the month's text copy for a late report", async () => {
    const w = fixture("followup");
    const root = dispatchState(w);
    await endAndLog(w);
    exportLog(root);
    const exported = () =>
      readFileSync(join(root, "log-2026-11.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((row) => row.key === `ended ${ID}`);
    expect(exported()).toMatchObject([{ by: "none" }]);
    expectSpawnExit(await report(w, SHORT), 0);
    exportLog(root);
    const lines = exported();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      by: "agent",
      concluded: SHORT.concluded,
      question: QUESTION,
      decision: DECISION,
      cause: "needs-person",
    });
  });

  it("keeps the report's fields on the ended row when the result arrives after the row and the report", async () => {
    const w = fixture();
    expectSpawnExit(await report(w, SHORT), 0);
    await endAndLog(w);
    expectSpawnExit(
      await w.dispatch(["result", ID, "earlier-token", "failed"]),
      0,
    );
    const [row] = ended(w);
    expect(row).toMatchObject({
      class: "gates failed",
      reason: "result failed",
      by: "agent",
      concluded: SHORT.concluded,
      question: QUESTION,
      decision: DECISION,
      suggested_next: SHORT.suggested_next,
      cause: "needs-person",
    });
    expect(columns(w)).toEqual({ cause: "needs-person", report_by: "agent" });
  });

  it("takes a report before and after the result, the last valid one standing, and never touches the result", async () => {
    const w = fixture();
    const root = dispatchState(w);
    expectSpawnExit(await report(w, SHORT), 0);
    expect(readResult(ID, root)).toBeNull();
    expectSpawnExit(
      await w.dispatch(["result", ID, "earlier-token", "done", "--pr", "812"]),
      0,
    );
    expectSpawnExit(await report(w, REPORT), 0);
    const refused = await report(w, { ...REPORT, cause: "bored" });
    expectSpawnExit(refused, 2);
    expect(readResult(ID, root)).toBe("done");
    recordExit(
      ID,
      { at: "2026-11-14T10:20:00.000Z", code: 0, signal: null },
      root,
    );
    const read = readEnded(ID, root);
    expect(read?.result).toBe("done");
    expect(read?.next).toEqual({
      address: "drive@example-org/example-repo#812",
    });
    expect(read?.report?.report as unknown).toEqual(REPORT);
  });

  it("refuses a report that fails the check, naming what is wrong, and records nothing", async () => {
    const w = fixture();
    const refused = await report(w, {
      ...REPORT,
      concluded: "x".repeat(601),
      decision: DECISION,
      evidence: ["the whole log"],
    });
    expectSpawnExit(refused, 2);
    expect(refused.stderr).toContain("$.concluded: must be at most 600");
    expect(refused.stderr).toContain(
      "$.decision: is only for a report with a question",
    );
    expect(refused.stderr).toContain("$.evidence[0]");
    expectSpawnExit(await report(w, "{not json"), 2);
    expect(readEnded(ID, dispatchState(w))).toBeNull();
    recordExit(
      ID,
      { at: "2026-11-14T10:20:00.000Z", code: 0, signal: null },
      dispatchState(w),
    );
    expect(readEnded(ID, dispatchState(w))?.report).toBeNull();
  });

  it("redacts what it keeps", async () => {
    const w = fixture("steward");
    expectSpawnExit(
      await report(w, {
        ...REPORT,
        concluded: "Asked dev@example.test about it.",
      }),
      0,
    );
    recordExit(
      ID,
      { at: "2026-11-14T10:20:00.000Z", code: 0, signal: null },
      dispatchState(w),
    );
    expect(readEnded(ID, dispatchState(w))?.report?.report.concluded).toBe(
      "Asked <redacted> about it.",
    );
  });

  it("refuses another token, an unknown record and a drive's record", async () => {
    const w = fixture("rearm");
    const drive = await report(w, REPORT);
    expectSpawnExit(drive, 2);
    expect(drive.stderr).toContain("its driver writes its report");
    const other = await report(w, REPORT, "another-token");
    expectSpawnExit(other, 2);
    expect(other.stderr).toContain("not a launch record with that token");
    expectSpawnExit(
      await w.dispatch([
        "report",
        "20261114T000000Z-00000000",
        "earlier-token",
        reportFile(w, REPORT),
      ]),
      2,
    );
  });
});
