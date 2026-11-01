/**
 * Stage drift through real ticks: a drive this machine launched, still
 * running, whose unresolved review threads rise round after round, is
 * reported as drifting with its counts and notified once, never acted on.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { processTable } from "../../shared/process-table.ts";
import { bootId, readRecordFile } from "../lib/launches.ts";
import { readRows } from "../lib/log.ts";
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
  claimed,
  dispatchState,
  earlierRecord,
  machineFile,
} from "./launch-fixtures.ts";
import { orcaCalls } from "./pickup-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  drive_rounds_flat: 2
`;

const RECORD = "20261101T080000Z-dddddddd";

let current: World | null = null;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const clean of cleanups.splice(0)) clean();
  current?.close();
  current = null;
});

/** PR #7's ledger: its driver running with a fresh heartbeat, at `round`. */
function runningAt(w: World, round: number, threads: number): void {
  const ledger = stoppedLedger(7, undefined, { round });
  w.setComments(7, [
    ledgerComment(701, {
      ...ledger,
      driver: {
        ...ledger.driver,
        state: "running",
        started: new Date(Date.now() - 60_000).toISOString(),
        heartbeat: new Date().toISOString(),
      },
    }),
  ]);
  writeFileSync(join(w.dir, "threads-7"), String(threads));
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

describe("stage drift", () => {
  it("reports a drive whose unresolved threads rose across two rounds as drifting, and notifies it once", async () => {
    const w = world();
    current = w;
    w.setConfig(CONFIG);
    w.setPrs("open", [openPr(7, "feature/7")]);
    const ws = join(w.root, "ws-7");
    mkdirSync(ws, { recursive: true });
    w.setWorkspaces([{ branch: "feature/7", linkedPR: 7, path: ws }]);
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
    // This machine's re-arm of PR #7, its wrapper alive.
    const driver = Bun.spawn(["sleep", "120"]);
    cleanups.push(() => driver.kill());
    const row = (await processTable())?.find((r) => r.pid === driver.pid);
    earlierRecord(w, {
      id: RECORD,
      account: "a",
      createdAt: new Date().toISOString(),
      workspace: { id: "repo-1::/ws/0", path: ws },
      round: 1,
    });
    claimed(w, RECORD, {
      host: hostname(),
      bootId: bootId(),
      pid: driver.pid,
      start: row?.start ?? "",
      claimedAt: new Date().toISOString(),
    });

    const drifting = (r: TickReceipt) =>
      (r.repos[0]?.actions ?? []).filter((a) => a.cause === "drifting");
    const sent = (r: TickReceipt) =>
      (r.repos[0]?.notifications ?? []).filter((n) => n.cause === "drifting");

    runningAt(w, 1, 2);
    expect(drifting(await tick(w))).toEqual([]);
    runningAt(w, 2, 3);
    expect(drifting(await tick(w))).toEqual([]);
    runningAt(w, 3, 4);
    const third = await tick(w);
    const [cause] = drifting(third);
    expect(cause?.target).toBe("PR #7");
    expect(cause?.reason).toContain(
      "went from 2 at round 1 to 4 at round 3, not below over 2 recorded round(s)",
    );
    expect(cause?.evidence.threadsPerRound).toBe(
      "round 1: 2, round 2: 3, round 3: 4",
    );
    expect(sent(third).map((n) => n.outcome)).toEqual(["sent"]);
    runningAt(w, 4, 5);
    const fourth = await tick(w);
    expect(sent(fourth).map((n) => n.outcome)).toEqual(["suppressed"]);

    // One message, never an action on the drive.
    expect(orcaCalls(w, "worktree", "set")).toHaveLength(1);
    expect(fourth.repos[0]?.launches).toEqual([]);
    expect(
      readRecordFile(RECORD, dispatchState(w))?.samples?.map((s) => [
        s.round,
        s.threads,
      ]),
    ).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    const events = readRows(undefined, undefined, dispatchState(w)).filter(
      (r) => r.kind === "event",
    );
    expect(
      events.map((e) => [e.kind === "event" && e.event, e.target, e.stage]),
    ).toEqual([["drifting", "PR #7", "rearm"]]);
  }, 90_000);
});
