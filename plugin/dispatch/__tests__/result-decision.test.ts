/**
 * `jig dispatch result <record> <token> failed --decision <file>`: a pass
 * that stopped for a person records the decision it framed with its result,
 * checked as a park's is, kept with its digest; a decision the check refuses
 * records nothing, so the pass can fix it and send it again.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { decisionDigest } from "../../shared/decisions/digest.ts";
import type { ParkedDecision } from "../../shared/decisions/park.ts";
import { readEnded, readResult, recordExit } from "../lib/launches.ts";
import { world, type World } from "./fixtures.ts";
import { dispatchState, earlierRecord } from "./launch-fixtures.ts";

const ID = "20261112T101301Z-33c6fa5f";

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

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function fixture(action: "pickup" | "followup" | "rearm" = "pickup"): World {
  const w = world();
  current = w;
  earlierRecord(w, {
    id: ID,
    account: "a",
    action,
    ...(action === "pickup" ? { item: "#12", pr: null } : { pr: 12 }),
  });
  recordExit(
    ID,
    { at: "2026-11-12T10:20:00.000Z", code: 1, signal: null },
    dispatchState(w),
  );
  return w;
}

function decisionFile(w: World, value: unknown): string {
  const path = join(w.root, "decision.json");
  writeFileSync(
    path,
    typeof value === "string" ? value : JSON.stringify(value),
  );
  return path;
}

const result = (w: World, ...args: string[]) =>
  w.dispatch(["result", ID, "earlier-token", ...args]);

describe("jig dispatch result … failed --decision", () => {
  it("keeps the decision with the failed result and its digest", async () => {
    const w = fixture();
    const ran = await result(
      w,
      "failed",
      "--decision",
      decisionFile(w, DECISION),
    );
    expectSpawnExit(ran, 0);
    expect(JSON.parse(ran.stdout)).toMatchObject({
      record: ID,
      item: "#12",
      result: "failed",
      decision: decisionDigest(DECISION),
    });
    const read = readEnded(ID, dispatchState(w));
    expect(read?.result).toBe("failed");
    expect(read?.framed).toMatchObject({
      decision: DECISION,
      digest: decisionDigest(DECISION),
    });
    // The result stands: a second one is refused.
    expectSpawnExit(await result(w, "failed"), 3);
  });

  it("records nothing for a decision the check refuses, naming what is wrong, so the pass can send it again", async () => {
    const w = fixture("followup");
    const wrong = {
      ...DECISION,
      call: {
        ...DECISION.call,
        question: "Keep the column",
        recomended: "keep",
      },
    };
    const refused = await result(
      w,
      "failed",
      "--decision",
      decisionFile(w, wrong),
    );
    expectSpawnExit(refused, 2);
    expect(refused.stderr).toContain("$.call.question");
    expect(refused.stderr).toContain("recomended");
    expect(readResult(ID, dispatchState(w))).toBeNull();
    expectSpawnExit(
      await result(w, "failed", "--decision", decisionFile(w, DECISION)),
      0,
    );
  });

  it("refuses a decision that is not JSON, one under the dispatcher's own class, and one beside done", async () => {
    const w = fixture();
    expectSpawnExit(
      await result(w, "failed", "--decision", decisionFile(w, "{not json")),
      2,
    );
    const own = await result(
      w,
      "failed",
      "--decision",
      decisionFile(w, { ...DECISION, class: "pickup-recovery" }),
    );
    expectSpawnExit(own, 2);
    expect(own.stderr).toContain("dispatcher's own framing");
    expectSpawnExit(
      await result(w, "done", "--decision", decisionFile(w, DECISION)),
      2,
    );
    expectSpawnExit(
      await result(
        w,
        "failed",
        "--pr",
        "3",
        "--decision",
        decisionFile(w, DECISION),
      ),
      2,
    );
    expect(readResult(ID, dispatchState(w))).toBeNull();
  });

  it("refuses a drive's record, whose exit is its answer", async () => {
    const w = fixture("rearm");
    const ran = await result(
      w,
      "failed",
      "--decision",
      decisionFile(w, DECISION),
    );
    expectSpawnExit(ran, 2);
    expect(ran.stderr).toContain("drive's record");
  });
});
