/**
 * How the tick settles the failure ledger's rows of its own: a tick that
 * exits 0 clears its row only once the exit is final, so a failure that
 * never stops keeps its streak, and the sweep's row goes once the machine
 * lists a single repository.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FAILURE_DEFAULTS,
  readFailures,
  recordFailure,
} from "../lib/failures.ts";
import type { MachineConfig } from "../lib/machine-config.ts";
import { closeStateDb } from "../lib/state.ts";
import type { TickContext } from "../lib/tick-context.ts";
import { finalizeTickFailure, settleFailures } from "../lib/tick-settle.ts";
import type { TickReceipt } from "../receipts.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    closeStateDb(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function world(listed: string[]): {
  root: string;
  context: TickContext;
  receipt: TickReceipt;
} {
  const root = mkdtempSync(join(tmpdir(), "dispatch-settle-"));
  roots.push(root);
  const machine = {
    repositories: listed.map((path) => ({
      path,
      stages: ["notify"],
      owner: true,
    })),
  } as unknown as MachineConfig;
  const context = {
    options: { apply: true, machine, repos: listed },
    apply: { root },
  } as unknown as TickContext;
  const receipt = {
    exitStatus: 0,
    repos: listed.map((path) => ({
      path,
      slug: `o/${path.slice(1)}`,
      refused: null,
      records: [],
      unplaced: [],
    })),
  } as unknown as TickReceipt;
  return { root, context, receipt };
}

const SWEEP = {
  repo: "",
  key: "ticks sweep",
  kind: "tick" as const,
  target: "ticks of several repositories",
};

describe("the tick's own failure row", () => {
  it("keeps its streak when the exit is 0 at the close and 1 once the dashboard's line is written", () => {
    const { root, context, receipt } = world(["/a", "/b"]);
    const first = recordFailure(
      SWEEP,
      "the line failed",
      Date.now() - 1000,
      FAILURE_DEFAULTS,
      root,
    );
    settleFailures(receipt, context);
    expect(readFailures(undefined, root).map((r) => r.count)).toEqual([1]);
    receipt.exitStatus = 1;
    finalizeTickFailure(receipt, context);
    const [row] = readFailures(undefined, root);
    expect(row?.count).toBe(2);
    expect(row?.firstAt).toBe(first.firstAt);
  });

  it("clears the row once the exit holds at 0", () => {
    const { root, context, receipt } = world(["/a", "/b"]);
    recordFailure(SWEEP, "the line failed", Date.now(), FAILURE_DEFAULTS, root);
    settleFailures(receipt, context);
    finalizeTickFailure(receipt, context);
    expect(readFailures(undefined, root)).toEqual([]);
  });

  it("retires the sweep's row once a single repository is listed", () => {
    const { root, context, receipt } = world(["/a"]);
    recordFailure(SWEEP, "the line failed", Date.now(), FAILURE_DEFAULTS, root);
    settleFailures(receipt, context);
    expect(readFailures(undefined, root)).toEqual([]);
  });
});

describe("why a tick failed", () => {
  it("keeps a repository's stage defect and its reason as the repository's failure", () => {
    const { root, context, receipt } = world(["/a"]);
    const repo = receipt.repos[0] as unknown as { stageDefects: unknown[] };
    repo.stageDefects = [
      { code: "defect", phase: "apply", stage: "notify", reason: "notify threw" },
    ];
    settleFailures(receipt, context);
    const rows = readFailures(undefined, root);
    expect(rows.map((r) => r.kind)).toEqual(["repository"]);
    expect(rows[0]?.reason).toContain("notify threw");
  });

  it("names the dashboard line's failure for an otherwise successful tick", () => {
    const { root, context, receipt } = world(["/a", "/b"]);
    settleFailures(receipt, context);
    receipt.exitStatus = 1;
    receipt.lineFailed = "disk full";
    finalizeTickFailure(receipt, context);
    const [row] = readFailures(undefined, root);
    expect(row?.reason).toContain("disk full");
    expect(row?.reason).not.toContain("no cause");
  });
});

describe("whether a tick failed", () => {
  it("counts an individually unreadable claim, ledger or marker as a failed tick", async () => {
    const { settleOutcomes } = await import("../lib/tick-settle.ts");
    const { context, receipt } = world(["/a"]);
    Object.assign(context, { launches: [], nowMs: Date.now() });
    const repo = receipt.repos[0] as unknown as { unplaced: unknown[] };
    expect(await settleOutcomes(receipt, context, undefined)).toBe(false);
    repo.unplaced.push({
      target: "PR #4",
      record: "forge",
      reason: "its ledger did not read",
      readFailed: true,
    });
    expect(await settleOutcomes(receipt, context, undefined)).toBe(true);
  });
});
