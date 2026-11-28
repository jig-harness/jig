/**
 * dispatch --apply: a re-arm that stops `NOT_SETTLED` (exit 4, not
 * judgeable yet) again is not re-armed by the next tick while the pull
 * request's head and its reviews are unchanged, and the report says why; a
 * review of that head or a new head re-arms it. At `not_settled.notify_after`
 * such stops on one head the drive is a person's: one needs-person event
 * row naming the state the drive kept reporting, and one notice.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { isoFromMs, currentMs } from "../../shared/time.ts";
import { readRows } from "../lib/log.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  BASE_SHA,
  HEAD_SHA,
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
  driveRuns,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

const HEAD = "feature/7-attach";
const STATE = "AWAITING_REVIEWER";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** PR #7's ledger, stopped `NOT_SETTLED` at ledger generation `generation`: each re-arm's run moves it. */
function ledgerAt(w: World, generation: number): void {
  w.setComments(7, [
    ledgerComment(
      701,
      stoppedLedger(7, DRIVE_EXIT.NOT_SETTLED, { generation }),
    ),
  ]);
}

/** A drive of PR #7 stopped `NOT_SETTLED`, whose every re-arm stops `NOT_SETTLED` again, its status probe reporting `AWAITING_REVIEWER`. */
function fixture(machine: Record<string, unknown> = {}): World {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  renotify_after: 1h\n`,
  );
  withOrigin(w);
  w.setPrs("open", [openPr(7, HEAD)]);
  ledgerAt(w, 3);
  w.setBaseHead(HEAD_SHA);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: ws }]);
  writeFileSync(join(w.dir, "drive-exit"), String(DRIVE_EXIT.NOT_SETTLED));
  const probe = {
    code: DRIVE_EXIT.NOT_SETTLED,
    state: STATE,
    reason: "the reviewer has not reviewed this head yet",
  };
  writeFileSync(
    join(w.dir, "drive-stderr"),
    `drive.ts: status probe stopped: ${JSON.stringify(probe)}\n`,
  );
  machineFile(
    w,
    [account(w, "a", "a@example.com"), account(w, "b", "b@example.com")],
    machine,
    ["rearm", "notify"],
  );
  return w;
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

/** A tick that re-arms PR #7, waited on until the re-arm's exit is recorded; the run moves the ledger to `generation`. */
async function rearmed(w: World, generation: number): Promise<void> {
  const receipt = await tick(w);
  const launch = receipt.repos[0]?.launches?.[0];
  expect(launch).toMatchObject({ action: "rearm", outcome: "launched" });
  await waitFor("the re-arm's exit", () =>
    exitWritten(w, launch?.record ?? ""),
  );
  ledgerAt(w, generation);
}

/** PR #7's reviews as the forge lists them: one of `commit`, submitted a second from now, so after any end already recorded. */
function reviewOf(w: World, commit: string): void {
  writeFileSync(
    join(w.dir, "reviews-7.json"),
    JSON.stringify([
      {
        state: "COMMENTED",
        submittedAt: isoFromMs(currentMs() + 1000),
        commit: { oid: commit },
      },
    ]),
  );
}

describe("a re-arm that stops NOT_SETTLED again", () => {
  it("is not re-armed while the head and its reviews are unchanged, and is once a review of that head appears", async () => {
    const w = fixture();
    await rearmed(w, 4);

    const held = await tick(w);
    const repo = held.repos[0];
    expect(repo?.launches).toEqual([]);
    const quiet = repo?.quiet.find((q) => q.target === "PR #7");
    expect(quiet?.why).toContain(
      `re-arm 1 of 3 at head ${HEAD_SHA.slice(0, 12)} also stopped ${DRIVE_EXIT.NOT_SETTLED}, reporting ${STATE}, so it is not re-armed until`,
    );
    expect(quiet?.why).toContain("a review of that head or a new head");

    // A review of another commit is not a review of this head.
    reviewOf(w, BASE_SHA);
    expect((await tick(w)).repos[0]?.launches).toEqual([]);
    expect(driveRuns(w)).toHaveLength(1);

    reviewOf(w, HEAD_SHA);
    await rearmed(w, 5);
    expect(driveRuns(w)).toHaveLength(2);
  }, 120_000);

  it("is re-armed once the pull request has a new head", async () => {
    const w = fixture();
    await rearmed(w, 4);
    expect((await tick(w)).repos[0]?.launches).toEqual([]);

    w.setPrs("open", [openPr(7, HEAD, { headRefOid: BASE_SHA })]);
    w.setBaseHead(BASE_SHA);
    await rearmed(w, 5);
    expect(driveRuns(w)).toHaveLength(2);
  }, 120_000);

  it("is a person's at not_settled.notify_after: one needs-person event row naming the state, and one notice", async () => {
    const w = fixture({ not_settled: { notify_after: 2, backoff: "1h" } });
    await rearmed(w, 4);
    reviewOf(w, HEAD_SHA);
    await rearmed(w, 5);

    const capped = await tick(w);
    const repo = capped.repos[0];
    expect(repo?.launches).toEqual([]);
    const [action] = repo?.actions ?? [];
    expect(action).toMatchObject({
      stage: "notify",
      target: "PR #7",
      cause: "needs-person",
    });
    expect(action?.reason).toContain(
      `after 2 re-arms in a row at the same pull request head ${HEAD_SHA.slice(0, 12)}, reporting ${STATE}`,
    );
    expect(action?.evidence).toMatchObject({
      notSettledRearms: 2,
      notSettledState: STATE,
    });
    expect(repo?.notifications).toMatchObject([
      { cause: "needs-person", outcome: "sent" },
    ]);

    const again = await tick(w);
    expect(again.repos[0]?.launches).toEqual([]);
    expect(
      (again.repos[0]?.notifications ?? []).filter((n) => n.outcome === "sent"),
    ).toEqual([]);
    const needs = readRows(undefined, undefined, dispatchState(w)).filter(
      (row) => row.kind === "event" && row.event === "needs-person",
    );
    expect(needs).toHaveLength(1);
    expect(needs[0]?.reason).toContain(STATE);
    expect(driveRuns(w)).toHaveLength(2);
  }, 120_000);
});
