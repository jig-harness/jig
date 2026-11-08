/**
 * The line a tick from the machine file leaves in the state database, over the
 * fake forge and a fake `orca`: what the dashboard shows comes from a real
 * tick's reads. A tick for one repository leaves the whole line as it was, and
 * a tick whose line cannot be written still launches, and says so on its receipt.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { scopedStateDir } from "../../skills/drive-pr/__tests__/scoped-state-dir.ts";
import { writeDriverRecord } from "../../skills/drive-pr/scripts/lib/ledger-stop.ts";
import { cloneId } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { worktreePathKey } from "../../skills/drive-pr/scripts/lib/state/actor.ts";
import {
  leaseRef,
  treeLeaseRef,
  readLease,
  readTreeLease,
} from "../../skills/drive-pr/scripts/lib/state/lease.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  dispatchState,
  machineFile,
  waitFor,
  exitWritten,
  recordIds,
} from "./launch-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

const HEAD = "feature/7-parked";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** A quota-parked PR #7 whose workspace exists. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  w.setPrs("open", [openPr(7, HEAD)]);
  w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16))]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: ws }]);
  return w;
}

function database(w: World): Database {
  return new Database(join(dispatchState(w), "state.sqlite"));
}

function storedLine(
  w: World,
): { line: LineSnapshot; receipt: TickReceipt } | null {
  const db = database(w);
  try {
    const row = db
      .query("SELECT line, receipt FROM tick_line WHERE id = 1")
      .get() as { line: string; receipt: string } | null;
    return row === null
      ? null
      : {
          line: JSON.parse(row.line) as LineSnapshot,
          receipt: JSON.parse(row.receipt) as TickReceipt,
        };
  } finally {
    db.close();
  }
}

async function tick(w: World, exit = 0): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, exit);
  return JSON.parse(r.stdout) as TickReceipt;
}

describe("the line a tick leaves", () => {
  it("reconciles a hand-armed released dead driver before planning and leaves no lease", async () => {
    const w = fixture();
    const leaf = scopedStateDir(w.env.DRIVE_PR_STATE_DIR as string, w.repo);
    const actor = `wt-${worktreePathKey(w.repo)}`;
    const started = "2026-10-30T20:00:00.000Z";
    const ledger = stoppedLedger(7, undefined);
    ledger.driver = {
      ...ledger.driver,
      actor,
      clone: cloneId(leaf),
      started,
      recoveryVersion: 1,
      position: 0,
      state: "running",
    };
    w.setComments(7, [ledgerComment(701, ledger)]);
    const child = Bun.spawn([process.execPath, "-e", ""], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(
      {
        exitCode: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      },
      0,
    );
    writeDriverRecord(leaf, "7", {
      worktree: w.repo,
      started,
      pid: child.pid,
      host: hostname(),
      released: true,
    });
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
    // Before the reconciliation a report reads the dead driver as one to take over.
    const report = await w.dispatch(["--json"]);
    expectSpawnExit(report, 0);
    expect(JSON.parse(report.stdout).repos[0].actions).toContainEqual(
      expect.objectContaining({
        stage: "rearm",
        takeoverGone: expect.stringContaining("no longer runs"),
      }),
    );
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["notify"]);
    const notifyOnly = await tick(w);
    expect(notifyOnly.repos[0]?.actions).toContainEqual(
      expect.objectContaining({ target: "PR #7", stage: "rearm" }),
    );
    expect(notifyOnly.repos[0]?.launches).toEqual([]);
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm"]);
    const applied = await tick(w);
    expect(applied.repos[0]?.actions).toContainEqual(
      expect.objectContaining({
        target: "PR #7",
        stage: "rearm",
        evidence: expect.objectContaining({
          driver: "stopped",
          noCause: true,
          exit: null,
        }),
      }),
    );
    expect(readLease(leaseRef(leaf, "7", actor))).toBeNull();
    expect(readTreeLease(treeLeaseRef(leaf, actor))).toBeNull();
    await waitFor("recovered drive wrapper exits", () =>
      recordIds(w).every((id) => exitWritten(w, id)),
    );
  });

  it("notifies an unrecoverable silent driver once and keeps its need on the line", async () => {
    const w = fixture();
    const ledger = stoppedLedger(7, undefined);
    const leaf = scopedStateDir(w.env.DRIVE_PR_STATE_DIR as string, w.repo);
    const started = "2026-10-30T20:00:00.000Z";
    ledger.driver = {
      ...ledger.driver,
      actor: `wt-${worktreePathKey(w.repo)}`,
      clone: cloneId(leaf),
      started,
      state: "running",
    };
    const child = Bun.spawn([process.execPath, "-e", ""], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(
      {
        exitCode: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      },
      0,
    );
    writeDriverRecord(leaf, "7", {
      worktree: w.repo,
      started,
      pid: child.pid,
      host: hostname(),
    });
    w.setComments(7, [ledgerComment(701, ledger)]);
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
    w.setWorkspaces([{ branch: "desk", path: join(w.root, "desk") }]);
    w.setConfig(`${CONFIG}dispatch:\n  notices_branch: desk\n`);
    const first = await tick(w);
    expect(first.repos[0]?.actions).toContainEqual(
      expect.objectContaining({
        target: "PR #7",
        stage: "notify",
        cause: "needs-person",
      }),
    );
    expect(first.repos[0]?.notifications).toContainEqual(
      expect.objectContaining({ outcome: "sent" }),
    );
    expect(storedLine(w)?.line.needs).toContainEqual(
      expect.objectContaining({
        target: "PR #7",
        cause: "needs-person",
      }),
    );
    const waiting = await w.dispatch(
      ["ask", "--waiting", "--json"],
      resolve(import.meta.dir, "../../jig.ts"),
    );
    expectSpawnExit(waiting, 0);
    expect(JSON.parse(waiting.stdout).waiting).toContainEqual(
      expect.objectContaining({
        address: "drive@example-org/example-repo#7",
        act: "re-arm",
      }),
    );
    const second = await tick(w);
    expect(second.repos[0]?.notifications).not.toContainEqual(
      expect.objectContaining({ outcome: "sent" }),
    );
  });

  it("names the parked drive's workspace without a running session in the JSON line", async () => {
    const w = fixture();
    w.setComments(7, [
      ledgerComment(
        701,
        stoppedLedger(7, 8, {
          parked: [
            {
              key: "F1",
              kind: "finding",
              reason: "Choose a retry budget",
              round: 2,
              at: "2026-10-30T21:00:00.000Z",
              class: "design-choice",
              record: "Choose a retry budget",
            },
          ],
        }),
      ),
    ]);
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
    await tick(w);
    const answer = await w.dispatch(["line", "--json"]);
    expectSpawnExit(answer, 0);
    const parsed = JSON.parse(answer.stdout) as {
      value: { line: LineSnapshot };
    };
    expect(parsed.value.line.sessions).toEqual([]);
    expect(parsed.value.line.needs).toContainEqual(
      expect.objectContaining({
        target: "PR #7",
        cause: "parked",
        workspace: join(w.root, "ws-7"),
      }),
    );
  });

  it("holds what the tick launched, on its account, and the receipt beside it", async () => {
    const w = fixture();
    machineFile(w, [account(w, "a", "a@example.com")], { interval: "10m" });
    const receipt = await tick(w);
    const record = receipt.repos[0]?.launches[0]?.record ?? "";
    expect(receipt.repos[0]?.launches[0]?.outcome).toBe("launched");
    await waitFor("the exit", () => exitWritten(w, record));

    const stored = storedLine(w);
    if (stored === null) throw new Error("the tick did not write its line");
    expect(stored.receipt.runId).toBe(receipt.runId);
    const line = stored.line;
    expect(line.runId).toBe(receipt.runId);
    expect(line.intervalMs).toBe(600_000);
    expect(line.apply).toBe(true);
    expect(line.accounts).toMatchObject([
      { name: "a", vendor: "claude", cap: 2, held: 1, wall: null },
    ]);
    expect(line.lastAccount).toBe("a");
    expect(line.sessions).toMatchObject([
      {
        record,
        account: "a",
        stage: "rearm",
        target: "PR #7",
        pr: 7,
        repo: SLUG,
        launch: "pending",
      },
    ]);
    expect(line.queue).toEqual([]);
    expect(line.repos).toMatchObject([{ slug: SLUG, stages: ["rearm"] }]);
    expect(line.recentTicksMs).toHaveLength(1);
    expect(line.ticks).toMatchObject([
      {
        runId: receipt.runId,
        sweep: true,
        exitStatus: 0,
        busy: [],
        lowBudget: null,
        defects: 0,
        repos: [{ repo: SLUG, defect: null }],
      },
    ]);
    const [entry] = line.ticks ?? [];
    expect(Object.keys(entry?.phasesMs ?? {})).toContain("start");
    expect(Object.keys(entry?.phasesMs ?? {})).toContain("close");
    expect(Object.keys(entry?.repos[0]?.phasesMs ?? {})).toContain("forge");
  });

  it("is left as it was by a tick for one repository out of the machine file's, which only adds itself to the recent ticks", async () => {
    const w = fixture();
    machineFile(w, [account(w, "a", "a@example.com")]);
    const first = await tick(w);
    expect(storedLine(w)?.line.runId).toBe(first.runId);
    // The forge knows no such repository, so the tick refuses it and ends 1.
    const r = await w.dispatch(["--repo", join(w.root, "another"), "--json"]);
    expectSpawnExit(r, 1);
    const second = JSON.parse(r.stdout) as TickReceipt;
    expect(second.runId).not.toBe(first.runId);
    expect(second.lineFailed).toBeUndefined();
    const stored = storedLine(w);
    expect(stored?.line.runId).toBe(first.runId);
    expect(stored?.receipt.runId).toBe(first.runId);
    expect(stored?.line.recentTicksMs).toHaveLength(1);
    expect(
      stored?.line.ticks?.map((t) => ({ runId: t.runId, sweep: t.sweep })),
    ).toEqual([
      { runId: first.runId, sweep: true },
      { runId: second.runId, sweep: false },
    ]);
  });

  it("reports a failed history read instead of silently skipping a partial tick", async () => {
    const w = fixture();
    machineFile(w, [account(w, "a", "a@example.com")]);
    await tick(w);
    const db = database(w);
    db.run("UPDATE tick_line SET line = 'invalid JSON' WHERE id = 1");
    db.close();
    const r = await w.dispatch(["--repo", join(w.root, "another"), "--json"]);
    expectSpawnExit(r, 1);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    expect(receipt.lineFailed).toContain("not JSON");
  });

  it("not written, leaves the launches standing and says so on the receipt, with exit 1", async () => {
    const w = fixture();
    machineFile(w, [account(w, "a", "a@example.com")]);
    const first = await tick(w);
    const record = first.repos[0]?.launches[0]?.record ?? "";
    await waitFor("the first launch's exit before changing its database", () =>
      exitWritten(w, record),
    );
    const db = database(w);
    db.run("DROP TABLE tick_line");
    db.close();
    // The drive of the first tick has ended and its wall is written: a new
    // pull request is what this tick launches.
    w.setPrs("open", [openPr(7, HEAD), openPr(8, "feature/8-parked")]);
    w.setComments(8, [ledgerComment(801, stoppedLedger(8, 16))]);
    const receipt = await tick(w, 1);
    expect(receipt.lineFailed).toContain(
      "the dashboard's line was not written",
    );
    expect(receipt.exitStatus).toBe(1);
    expect(receipt.completed).toBe(true);
    const launch = receipt.repos[0]?.launches[0];
    expect(launch?.outcome).toBe("launched");
    expect(recordIds(w)).toContain(launch?.record ?? "");
  });
});
