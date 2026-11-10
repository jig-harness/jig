/**
 * The tick re-reads a ledger before it writes its state label: a drive writes its own
 * label as soon as its ledger changes, and a tick that read the ledger
 * before that write reads it again before its own, and leaves the pull
 * request for a later tick when it changed.
 */
import { describe, expect, it } from "bun:test";
import {
  type Ledger,
  ledgerFromState,
} from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { freshState } from "../../skills/drive-pr/scripts/lib/state/schema.ts";
import { planLabels, writeLabels } from "../lib/actions/labels.ts";
import {
  type LedgerReread,
  ledgerStillCurrent,
} from "../lib/label-freshness.ts";
import type { LabelConfig } from "../lib/labels.ts";
import type { DrivenPr, LedgerClass } from "../lib/types.ts";
import { ok } from "../../shared/outcome.ts";

const ON: LabelConfig = { enabled: true, prefix: "jig:", onlyLabeled: false };
const RUNNING_AT = "2026-11-10T10:00:00.000Z";
const STOPPED_AT = "2026-11-10T10:05:00.000Z";

function ledger(
  generation: number,
  heartbeat: string,
  state: "running" | "stopped",
  exit?: number,
): Ledger {
  return ledgerFromState(freshState(7), {
    generation,
    driver: {
      actor: "wt-0123456789abcdef",
      clone: "clone-a",
      heartbeat,
      state,
      ...(exit === undefined ? {} : { exit }),
    },
    narrative: [],
    claims: [],
  });
}

/** The tick's reading of `l`, as the ledger source classifies it. */
function driven(l: Ledger, cls: LedgerClass): DrivenPr {
  return {
    number: 7,
    url: "",
    title: "",
    head: "feature/7",
    class: cls,
    why: "",
    evidence: {
      generation: l.generation,
      heartbeat: l.driver.heartbeat,
      driver: l.driver.state,
      exit: l.driver.exit ?? null,
    },
  };
}

/** One tick's projection of PR #7 carrying `labels`, written against the ledger `now` reads. */
async function tick(
  labels: string[],
  drives: DrivenPr[],
  now: Awaited<ReturnType<LedgerReread>>,
) {
  const { changes } = planLabels({
    config: ON,
    open: [{ number: 7, labels }],
    read: new Set([7]),
    drives,
    merged: [],
    followedUp: new Set(),
    followupFailed: new Set(),
    followupUnplaced: new Set(),
    manualOps: "manual-ops",
    own: [],
  });
  const edits: Array<{ add: readonly string[]; remove: readonly string[] }> =
    [];
  const writes = await writeLabels(
    "example-org/example-repo",
    changes,
    {
      apply: true,
      late: () => null,
      current: ledgerStillCurrent(new Set([7]), drives, async () => now),
    },
    async (_slug, _pr, add, remove) => {
      edits.push({ add, remove });
      return ok(undefined);
    },
  );
  return { edits, writes };
}

describe("a tick that read a ledger before a drive's label write", () => {
  it("does not put back driving over the converged label the drive wrote for its newer ledger", async () => {
    const read = ledger(3, RUNNING_AT, "running");
    // The drive stopped CONVERGED and labelled its pull request after the tick's read.
    const { edits, writes } = await tick(
      ["jig:converged"],
      [driven(read, "driven")],
      ledger(4, STOPPED_AT, "stopped", 0),
    );
    expect(edits).toEqual([]);
    expect(writes).toEqual([
      expect.objectContaining({
        target: "PR #7",
        outcome: "waits",
        detail: expect.stringContaining("changed since this tick read it"),
      }),
    ]);
  });

  it("does not take away the driving label a drive armed on a pull request it read with no ledger", async () => {
    const { edits } = await tick(
      ["jig:driving"],
      [],
      ledger(1, RUNNING_AT, "running"),
    );
    expect(edits).toEqual([]);
  });

  it("skips the write when the ledger does not read again", async () => {
    const read = ledger(3, RUNNING_AT, "running");
    const { edits, writes } = await tick(
      ["jig:stale"],
      [driven(read, "driven")],
      "the comments could not be read (HTTP 502)",
    );
    expect(edits).toEqual([]);
    expect(writes[0]?.detail).toContain("did not read again");
  });

  it("writes as before while the ledger is the one it read", async () => {
    const read = ledger(3, RUNNING_AT, "running");
    const { edits } = await tick(
      ["jig:stale"],
      [driven(read, "driven")],
      ledger(3, RUNNING_AT, "running"),
    );
    expect(edits).toEqual([{ add: ["jig:driving"], remove: ["jig:stale"] }]);
  });
});
