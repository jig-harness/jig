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
import { expectSpawnExited } from "../../../lib/test-helpers/expect-spawn-exit.ts";
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

/** A wake-up's own row, failed three times in a row so it escalates. */
function failingWakeUp(root: string, path: string): void {
  for (let i = 3; i >= 1; i--)
    recordFailure(
      {
        repo: "",
        key: `ticks ${path}`,
        kind: "tick",
        target: `ticks of o${path}`,
      },
      "the outcome log was not written",
      Date.now() - i * 60_000,
      FAILURE_DEFAULTS,
      root,
    );
}

/** A tick of `path` alone, with the machine listing every repository of `listed`. */
function wakeUp(
  listed: string[],
  path: string,
  root: string,
): { context: TickContext; receipt: TickReceipt } {
  const { context, receipt } = world(listed);
  (context as unknown as { apply: { root: string } }).apply.root = root;
  (context.options as unknown as { repos: string[] }).repos = [path];
  receipt.repos = receipt.repos.filter((r) => r.path === path);
  return { context, receipt };
}

describe("a wake-up's row after a sweep that read its repository", () => {
  it("is quiet once the sweep exits 0: it keeps its count and nothing escalates it", () => {
    const { root, context, receipt } = world(["/a", "/b"]);
    failingWakeUp(root, "/a");
    settleFailures(receipt, context);
    finalizeTickFailure(receipt, context);
    const [row] = readFailures(undefined, root);
    expect(row?.count).toBe(3);
    expect(row?.quietAt).not.toBeNull();
    expect(receipt.failures).toBeUndefined();
  });

  it("counts on from its kept count and escalates again when the next wake-up fails", () => {
    const { root, context, receipt } = world(["/a", "/b"]);
    failingWakeUp(root, "/a");
    settleFailures(receipt, context);
    finalizeTickFailure(receipt, context);
    const wake = wakeUp(["/a", "/b"], "/a", root);
    wake.receipt.exitStatus = 1;
    wake.receipt.lineFailed = "disk full";
    settleFailures(wake.receipt, wake.context);
    const [row] = readFailures(undefined, root);
    expect(row?.count).toBe(4);
    expect(row?.quietAt).toBeNull();
    expect(wake.receipt.failures?.escalated.map((e) => e.key)).toEqual([
      "ticks /a",
    ]);
  });

  it("is cleared by a wake-up of its repository that exits 0", () => {
    const { root, context, receipt } = world(["/a", "/b"]);
    failingWakeUp(root, "/a");
    settleFailures(receipt, context);
    finalizeTickFailure(receipt, context);
    const wake = wakeUp(["/a", "/b"], "/a", root);
    settleFailures(wake.receipt, wake.context);
    finalizeTickFailure(wake.receipt, wake.context);
    expect(readFailures(undefined, root)).toEqual([]);
  });

  it("stays escalated when its repository's turn failed in that sweep", () => {
    const { root, context, receipt } = world(["/a", "/b"]);
    failingWakeUp(root, "/a");
    (receipt.repos[0] as unknown as { refused: string }).refused = "refused";
    settleFailures(receipt, context);
    finalizeTickFailure(receipt, context);
    const wakeRow = readFailures(undefined, root).find(
      (r) => r.key === "ticks /a",
    );
    expect(wakeRow?.quietAt).toBeNull();
    expect(receipt.failures?.escalated.map((e) => e.key)).toContain("ticks /a");
  });

  it("stays escalated after a sweep that exits 1", () => {
    const { root, context, receipt } = world(["/a", "/b"]);
    failingWakeUp(root, "/a");
    receipt.exitStatus = 1;
    receipt.lineFailed = "disk full";
    settleFailures(receipt, context);
    const wakeRow = readFailures(undefined, root).find(
      (r) => r.key === "ticks /a",
    );
    expect(wakeRow?.quietAt).toBeNull();
  });
});

describe("why a tick failed", () => {
  it("keeps a repository's stage defect and its reason as the repository's failure", () => {
    const { root, context, receipt } = world(["/a"]);
    const repo = receipt.repos[0] as unknown as { stageDefects: unknown[] };
    repo.stageDefects = [
      {
        code: "defect",
        phase: "apply",
        stage: "notify",
        reason: "notify threw",
      },
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
    const { root, context, receipt } = world(["/a"]);
    Object.assign(context, { launches: [], nowMs: Date.now() });
    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { settleOutcomes } from ${JSON.stringify(join(import.meta.dir, "../lib/tick-settle.ts"))};
const context = ${JSON.stringify(context)};
const receipt = ${JSON.stringify(receipt)};
const before = await settleOutcomes(receipt, context, undefined);
receipt.repos[0].unplaced.push({ target: "PR #4", record: "forge", reason: "its ledger did not read", readFailed: true });
console.log(JSON.stringify([before, await settleOutcomes(receipt, context, undefined)]));`,
      ],
      {
        env: { ...process.env, HOME: root, USERPROFILE: root },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 30_000,
      },
    );
    await expectSpawnExited(child, 0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual([
      false,
      true,
    ]);
  });
});
