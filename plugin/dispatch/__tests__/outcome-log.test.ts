/**
 * The outcome log through real ticks: a drive the tick re-arms, which stops
 * on its account's usage-limit wall and is re-armed on another account
 * where it converges, leaves one ended row per launch with its class, and
 * no tick writes either row twice.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { type EndedRow, readRows } from "../lib/log.ts";
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
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const ended = (w: World) =>
  readRows(undefined, undefined, dispatchState(w)).filter(
    (r): r is EndedRow => r.kind === "ended",
  );

describe("the outcome log", () => {
  it("leaves two rows, quota wall then converged, for a drive that quota-parks and later converges", async () => {
    const w = world();
    current = w;
    w.setConfig(CONFIG);
    w.setPrs("open", [openPr(7, "feature/7-parked")]);
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 16, { round: 2 }))]);
    const ws = join(w.root, "ws-7");
    mkdirSync(ws, { recursive: true });
    w.setWorkspaces([{ branch: "feature/7-parked", linkedPR: 7, path: ws }]);
    machineFile(w, [
      account(w, "a", "a@example.com"),
      account(w, "b", "b@example.com"),
    ]);

    // The first pass meets its account's wall.
    writeFileSync(join(w.dir, "drive-exit"), "16");
    const first = (await tick(w)).repos[0]?.launches[0];
    expect(first).toMatchObject({
      action: "rearm",
      outcome: "launched",
      account: "a",
    });
    await waitFor("the first exit", () => exitWritten(w, first?.record ?? ""));

    // The next tick logs it, and re-arms on the account with no wall, where it converges.
    writeFileSync(join(w.dir, "drive-exit"), "0");
    const second = (await tick(w)).repos[0]?.launches[0];
    expect(second).toMatchObject({
      action: "rearm",
      outcome: "launched",
      account: "b",
    });
    await waitFor("the second exit", () =>
      exitWritten(w, second?.record ?? ""),
    );
    w.setComments(7, [ledgerComment(701, stoppedLedger(7, 0, { round: 5 }))]);
    await tick(w);
    await tick(w);

    const rows = ended(w);
    expect(
      rows.map((r) => [
        r.record,
        r.class,
        r.account,
        r.stage,
        r.target,
        r.rounds,
      ]),
    ).toEqual([
      [String(first?.record), "quota wall", "a", "rearm", "PR #7", 0],
      [String(second?.record), "converged", "b", "rearm", "PR #7", 3],
    ]);
    expect(rows.map((r) => r.reason)).toEqual([
      "exit 16 (quota-parked)",
      "exit 0 (converged)",
    ]);
    for (const r of rows) expect(r.durationMs).toBeGreaterThanOrEqual(0);
  }, 90_000);
});
