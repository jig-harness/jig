/**
 * A pass that exits 0 and records a wait (`waits`) or a stop on a decision
 * it framed for a person (`failed --decision`, read `parked`) is kept as
 * `failed` beside what tells it apart, so an older plugin holds it for a
 * person, and read apart from a failure everywhere: the launch result, the
 * outcome log's class and handoff, the recurring classes and the follow-up's
 * end. A pass that records `failed` with neither stays a failure.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { ParkedDecision } from "../../shared/decisions/park.ts";
import { currentMs, isoFromMs, parseMs } from "../../shared/time.ts";
import { followupEnd, outcomeOf } from "../lib/followup-outcomes.ts";
import {
  readEnded,
  readResult,
  recordExit,
  recordResult,
} from "../lib/launches.ts";
import { logEnded } from "../lib/log-ended.ts";
import { type EndedRow, insertRow, readRows } from "../lib/log.ts";
import { recurringClasses } from "../lib/recurring.ts";
import { stateDb } from "../lib/state.ts";
import { dispatchState, earlierRecord } from "./launch-fixtures.ts";
import { world, type World } from "./fixtures.ts";

const ID = "20261112T101301Z-33c6fa5f";
const ENDED_AT = "2026-11-12T10:20:00.000Z";

const DECISION: ParkedDecision = {
  schema: "parked-decision/v1",
  class: "scope",
  call: {
    id: "a",
    question: "Should the export keep the old column?",
    options: [
      {
        id: "keep",
        name: "Keep it",
        summary: "The column stays.",
        pay: ["A wider export."],
      },
      {
        id: "drop",
        name: "Drop it",
        summary: "The column goes.",
        pay: ["Readers of it break."],
      },
    ],
    recommended: "keep",
    why: "Readers of the column still exist.",
  },
  steps: [],
  alreadyDone: "The scouts ran.",
};

const PARKED_NEXT = {
  person: "repository maintainer",
  act: "Decide (scope): Should the export keep the old column?",
};

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A pickup or follow-up whose session exited 0 with no result yet. */
function endedClean(action: "pickup" | "followup"): World {
  const w = world();
  current = w;
  earlierRecord(w, {
    id: ID,
    account: "a",
    action,
    ...(action === "pickup" ? { item: "#12", pr: null } : { pr: 12 }),
  });
  recordExit(ID, { at: ENDED_AT, code: 0, signal: null }, dispatchState(w));
  return w;
}

const result = (w: World, ...args: string[]) =>
  w.dispatch(["result", ID, "earlier-token", ...args]);

/** The ended row the tick writes for the record, from a snapshot read before or after its result. */
async function logIt(w: World): Promise<void> {
  const root = dispatchState(w);
  const snapshot = readEnded(ID, root);
  if (snapshot === null) throw new TypeError("missing fixture launch");
  expect(
    await logEnded([snapshot], {
      all: [snapshot],
      drives: [],
      merged: async () => null,
      nowIso: "2026-11-12T10:21:00.000Z",
      root,
    }),
  ).toEqual([]);
}

/** The launch row's columns as they are kept, for the encoding an older plugin reads. */
function stored(w: World): {
  result: string | null;
  result_until: string | null;
  result_decision: string | null;
} {
  return stateDb(dispatchState(w))
    .query(
      "SELECT result, result_until, result_decision FROM launches WHERE id = ?",
    )
    .get(ID) as {
    result: string | null;
    result_until: string | null;
    result_decision: string | null;
  };
}

describe("a pass that ends waiting or parked, not failed", () => {
  for (const late of [false, true])
    it(`reads a follow-up that waits on a pending arm as waits, class arm pending, its result recorded ${late ? "after" : "before"} logging`, async () => {
      const w = endedClean("followup");
      const until = isoFromMs(currentMs() + 3_600_000);
      const record = () =>
        result(
          w,
          "waits",
          "--until",
          until,
          "--reason",
          "pending",
          "--arm",
          "release",
        );
      if (!late) expectSpawnExit(await record(), 0);
      await logIt(w);
      if (late) expectSpawnExit(await record(), 0);
      expect(stored(w)).toMatchObject({
        result: "failed",
        result_until: until,
      });
      const root = dispatchState(w);
      expect(readResult(ID, root)).toBe("waits");
      const [row] = readRows(undefined, undefined, root) as EndedRow[];
      expect(row?.class).toBe("arm pending");
      expect(row?.reason).toContain("still pending");
      const read = readEnded(ID, root);
      if (read === null) throw new TypeError("missing launch");
      expect(followupEnd(read)).toBe("waits");
      // The marker keeps its closed word, so a host on any release holds the follow-up.
      expect(outcomeOf(read)).toBe("failed");
    });

  for (const late of [false, true])
    it(`reads a pickup parked on its framed decision as parked, its handoff the decision's person and act, recorded ${late ? "after" : "before"} logging`, async () => {
      const w = endedClean("pickup");
      const path = join(w.root, "decision.json");
      writeFileSync(path, JSON.stringify(DECISION));
      const record = async () => {
        const ran = await result(w, "failed", "--decision", path);
        expectSpawnExit(ran, 0);
        expect(JSON.parse(ran.stdout)).toMatchObject({ next: PARKED_NEXT });
      };
      if (!late) await record();
      await logIt(w);
      if (late) await record();
      expect(stored(w).result).toBe("failed");
      expect(stored(w).result_decision).not.toBeNull();
      const root = dispatchState(w);
      expect(readResult(ID, root)).toBe("parked");
      expect(readEnded(ID, root)?.result).toBe("parked");
      expect(readRows(undefined, undefined, root)).toMatchObject([
        {
          class: "parked for a person",
          reason: `result parked: stopped on a question: ${DECISION.call.question}`,
          next: PARKED_NEXT,
        },
      ]);
    });

  it("reads a follow-up parked on its framed decision as a parked end, not a failure", async () => {
    const w = endedClean("followup");
    const path = join(w.root, "decision.json");
    writeFileSync(path, JSON.stringify(DECISION));
    expectSpawnExit(await result(w, "failed", "--decision", path), 0);
    await logIt(w);
    const root = dispatchState(w);
    const read = readEnded(ID, root);
    if (read === null) throw new TypeError("missing launch");
    expect(followupEnd(read)).toBe("parked");
    expect(outcomeOf(read)).toBe("failed");
    expect(readRows(undefined, undefined, root)).toMatchObject([
      { class: "parked for a person", next: PARKED_NEXT },
    ]);
  });

  it("keeps a pass that records failed with no wait and no decision a failure", async () => {
    const w = endedClean("pickup");
    expectSpawnExit(await result(w, "failed"), 0);
    await logIt(w);
    const root = dispatchState(w);
    expect(readResult(ID, root)).toBe("failed");
    expect(stored(w)).toMatchObject({
      result: "failed",
      result_until: null,
      result_decision: null,
    });
    expect(readRows(undefined, undefined, root)).toMatchObject([
      { class: "gates failed", reason: "result failed" },
    ]);
    const read = readEnded(ID, root);
    if (read === null) throw new TypeError("missing launch");
    expect(followupEnd(read)).toBe("failed");
  });

  it("reads rows an earlier release wrote, failed beside a wait or a decision, as waits and parked", async () => {
    const w = endedClean("pickup");
    const root = dispatchState(w);
    // An earlier release kept the decision with `failed` and a handoff to nobody.
    stateDb(root)
      .query(
        "UPDATE launches SET result = 'failed', result_at = ?, result_next = ?, result_decision = ? WHERE id = ?",
      )
      .run(
        ENDED_AT,
        JSON.stringify({ none: "no handoff was recorded: result failed" }),
        JSON.stringify({
          decision: DECISION,
          digest: "0123456789ab",
          at: ENDED_AT,
        }),
        ID,
      );
    expect(readResult(ID, root)).toBe("parked");
    await logIt(w);
    expect(readRows(undefined, undefined, root)).toMatchObject([
      { class: "parked for a person", next: PARKED_NEXT },
    ]);
    stateDb(root)
      .query(
        "UPDATE launches SET result_decision = NULL, result_until = ? WHERE id = ?",
      )
      .run("2026-11-12T11:20:00.000Z", ID);
    expect(readResult(ID, root)).toBe("waits");
  });

  it("refuses a parked result without the decision it framed", () => {
    const w = endedClean("pickup");
    expect(() => recordResult(ID, "parked", dispatchState(w))).toThrow(
      "needs the decision it framed",
    );
  });

  it("never counts a follow-up waiting on a pending arm as a recurring bad class", () => {
    const w = world();
    current = w;
    const db = stateDb(dispatchState(w));
    const nowMs = parseMs("2026-11-12T12:00:00.000Z");
    for (const day of [0, 1, 2])
      for (const cls of ["arm pending", "gates failed"] as const) {
        const at = isoFromMs(nowMs - day * 86_400_000 - 3_600_000);
        insertRow(db, {
          kind: "ended",
          key: `ended ${cls} ${day}`,
          at,
          repo: "example-org/example-repo",
          stage: "followup",
          target: "PR #12",
          record: `${cls} ${day}`,
          account: "a",
          model: null,
          durationMs: null,
          rounds: null,
          class: cls,
          reason: "fixture",
        });
      }
    expect(recurringClasses(db, nowMs, "UTC").map((r) => r.class)).toEqual([
      "gates failed",
    ]);
  });
});
