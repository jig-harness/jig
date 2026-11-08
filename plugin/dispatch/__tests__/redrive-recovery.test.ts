/**
 * dispatch: the stops whose next step is mechanical and that draw on the
 * pull request's recovery budget. A pass deadline with its restarts spent
 * (`15`) is re-driven once per head commit; a failure (`1`) while the pull
 * request conflicts with its base is re-driven once per head and base head,
 * so its conflict-resolve round runs; a second stop at the same change is a
 * person's. Every such re-drive and every no-cause re-arm of the pull
 * request draw on one budget.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { SharedClaim } from "../../shared/records/shared.ts";
import { worktreePathKey } from "../../skills/drive-pr/scripts/lib/state/actor.ts";
import type { DriveEvent } from "../../skills/drive-pr/scripts/lib/state/events.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { hostLabel } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { settleConflictStops } from "../lib/actions/drive-hold.ts";
import { type ReadRecord, readRecord } from "../lib/launches.ts";
import { noCauseFacts, settleNoCauseStops } from "../lib/no-cause-stops.ts";
import { classifyLedger, type PrFacts } from "../lib/sources/ledgers.ts";
import type { DrivenPr } from "../lib/types.ts";
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

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const WINDOW = 240 * 60_000;
const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);
const MOVED = "b".repeat(40);

/** The stop event of a stop that measured its tree: whether it left work there. */
const measured = (exit: number, leftWork: boolean): DriveEvent => ({
  at: "2026-11-07T11:00:00.000Z",
  round: 3,
  kind: "stop",
  cause: String(exit),
  leftWork,
  tree: "wt-0123456789abcdef@h",
});

/** A drive of PR #7 as the tick reads it once its ledger is classified beside `forge`; a deadline stop measured its tree clean unless `events` say otherwise. */
function drive(
  exit: number,
  forge: PrFacts,
  events: DriveEvent[] = exit === 15 ? [measured(15, false)] : [],
): DrivenPr {
  const ledger = stoppedLedger(7, exit, { events });
  return {
    number: 7,
    url: `https://github.com/${SLUG}/pull/7`,
    title: "Pull request 7",
    head: "feature/7",
    ...classifyLedger(ledger, NOW, WINDOW, undefined, forge),
    evidence: {
      generation: ledger.generation,
      exit,
      heartbeat: ledger.driver.heartbeat,
      mergeable: forge.mergeable,
    },
  };
}

/** This machine's ended re-drive of PR #7 for `pr`'s change, as the tick reads it. */
function redrove(pr: DrivenPr, exit: number): ReadRecord {
  return {
    record: {
      version: 1,
      id: "20261107T110000Z-aaaaaaaa",
      token: "t",
      action: "rearm",
      repo: SLUG,
      repoPath: "/repo",
      pr: 7,
      item: null,
      account: "a",
      vendor: "claude",
      configDir: "/config-a",
      wallBackoffMs: 0,
      replaces: null,
      facts: "recovery: generation 3",
      createdAt: "2026-11-07T11:00:00.000Z",
      workspace: null,
      attempts: [],
      agentId: null,
      model: null,
      effort: null,
      released: false,
      command: null,
      marker: null,
      redrive: pr.stale ?? null,
    },
    state: {
      kind: "ended",
      exit: { at: "2026-11-07T11:30:00.000Z", code: exit, signal: null },
      process: null,
    },
    result: null,
  };
}

describe("a recovery stop's ledger", () => {
  it("re-drives a pass deadline once per head commit, then hands it to a person", () => {
    const placed = drive(15, { head: HEAD, mergeable: "MERGEABLE" });
    expect(placed.class).toBe("stale");
    expect(placed.stale).toEqual({
      cause: "stopped 15, a pass reached its deadline with its restarts spent",
      change: `head ${HEAD}, stopped 15`,
      mechanicalStop: "deadline",
      recovery: true,
    });
    const [again] = settleConflictStops([placed], [redrove(placed, 15)]);
    expect(again?.class).toBe("needs-person");
    expect(again?.why).toContain(
      "only a person settles it until its head moves",
    );
    // The killed passes' work stays in their tree: a stop that measured work left is bound to it.
    const at = (events: DriveEvent[]) =>
      drive(15, { head: HEAD, mergeable: "MERGEABLE" }, events).stale?.tree;
    expect(at([measured(15, true)])).toEqual({
      actor: "wt-0123456789abcdef",
      here: false,
    });
    // One that never measured, from a driver that did not record it, re-drives anywhere.
    expect(at([])).toBeUndefined();
    // A new head is a new attempt.
    const moved = drive(15, { head: MOVED, mergeable: "MERGEABLE" });
    expect(settleConflictStops([moved], [redrove(placed, 15)])[0]?.class).toBe(
      "stale",
    );
  });

  it("re-drives a failure on a conflicting pull request once per head and base head", () => {
    const conflicting = { head: HEAD, mergeable: "CONFLICTING" };
    const placed = drive(1, { ...conflicting, base: { oid: BASE } });
    expect(placed).toMatchObject({
      class: "stale",
      stale: {
        cause: "stopped 1, and its pull request conflicts with its base",
        change: `head ${HEAD}, base ${BASE}`,
        conflictStop: true,
        recovery: true,
      },
    });
    const [again] = settleConflictStops([placed], [redrove(placed, 1)]);
    expect(again?.class).toBe("needs-person");
    expect(again?.why).toContain(
      "stopped 1, and its pull request conflicts with its base, and launch record",
    );
    expect(again?.why).toContain("until its head or its base moves");
    // A stop on a conflict re-driven at the same pair already ran that round.
    const nine = drive(9, { ...conflicting, base: { oid: BASE } });
    expect(settleConflictStops([placed], [redrove(nine, 9)])[0]?.class).toBe(
      "needs-person",
    );
    // A base that moved is a new attempt.
    const rebased = drive(1, { ...conflicting, base: { oid: MOVED } });
    expect(settleConflictStops([rebased], [redrove(placed, 1)])[0]?.class).toBe(
      "stale",
    );
    // Not conflicting, it is a crash only a person settles; still computing, it waits.
    expect(drive(1, { head: HEAD, mergeable: "MERGEABLE" }).class).toBe(
      "needs-person",
    );
    expect(drive(1, { head: HEAD, mergeable: "UNKNOWN" }).class).toBe(
      "unplaced",
    );
    expect(drive(1, conflicting).why).toContain(
      "the head of its base branch does not read",
    );
  });
});

/** Another host's ended launch claim on PR #7, acting on `facts`. */
function claim(id: number, facts: string): SharedClaim {
  const at = new Date(NOW - id * 60_000).toISOString();
  return {
    id,
    stage: "drive",
    login: "drive-bot",
    createdAt: at,
    trusted: true,
    says: {
      ok: true,
      value: {
        pr: 7,
        attempt: id,
        at,
        run: "tick",
        action: "rearm",
        record: `launch-${id}`,
        host: `host-${id}`,
        owner: true,
        facts,
        change: null,
        conflictStop: false,
        end: { state: "ended", at, exit: null, outcome: null },
        legacy: false,
      },
    },
  };
}

describe("the recovery budget", () => {
  it("is one per pull request, shared by no-cause re-arms and every recovery re-drive", () => {
    const accidental: DrivenPr = {
      ...drive(15, { head: HEAD, mergeable: "MERGEABLE" }),
      class: "re-armable",
      evidence: {
        noCause: true,
        legacyNoCause: false,
        generation: 2,
        exit: null,
        heartbeat: "2026-11-07T10:00:00.000Z",
      },
    };
    const spent = [
      claim(1, noCauseFacts(accidental)),
      claim(2, "recovery: generation 3, exit 15, heartbeat x"),
      claim(3, "recovery: generation 4, exit 1, heartbeat y"),
    ];
    const settle = (pr: DrivenPr, rows: SharedClaim[]) =>
      settleNoCauseStops(
        [pr],
        [],
        new Map([[7, { ok: true, value: rows }]]),
        NOW,
      )[0];
    const deadline = drive(15, { head: MOVED, mergeable: "MERGEABLE" });
    expect(settle(deadline, spent.slice(0, 2))?.class).toBe("stale");
    const refused = settle(deadline, spent);
    expect(refused?.class).toBe("needs-person");
    expect(refused?.why).toContain(
      "repeated recovery re-drives: needs a person; 3 recovery attempts within one hour (budget 3)",
    );
    // The same three attempts spend a no-cause re-arm's budget too.
    expect(settle(accidental, spent)?.class).toBe("stopped-unknown");
    // A stall's re-drive is bounded by its head alone.
    expect(
      settle(drive(14, { head: MOVED, mergeable: "MERGEABLE" }), spent)?.class,
    ).toBe("stale");
    // A silent driver no launch started, which this host shows gone, is notified, not taken over.
    const silent: DrivenPr = {
      ...deadline,
      class: "silent",
      evidence: { ...deadline.evidence, driverGone: true, unlaunched: true },
    };
    const { stale: _none, ...gone } = silent;
    expect(settle(gone, spent)).toMatchObject({
      class: "silent",
      evidence: { driverGone: false },
    });
    // One a launch started is not the budget's.
    const attributed = {
      ...gone,
      evidence: { ...gone.evidence, unlaunched: false },
    };
    expect(settle(attributed, spent)).toEqual(attributed);
  });
});

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

/** The ledger as a drive that just stopped `exit` wrote it, its heartbeat now; a deadline stop measured its tree clean unless `extra` says otherwise. */
function stop(
  exit: number | undefined,
  generation: number,
  extra: Partial<Ledger> = {},
): Ledger {
  const ledger = stoppedLedger(7, exit, {
    ...(exit === 15 ? { events: [measured(15, false)] } : {}),
    ...extra,
  });
  return {
    ...ledger,
    generation,
    driver: {
      ...ledger.driver,
      heartbeat: new Date().toISOString(),
      ...(exit === undefined ? { recoveryVersion: 1 as const } : {}),
      ...extra.driver,
    },
  };
}

/** PR #7 as the forge lists it, its drive stopped `ledger`'s way; its workspace exists, and account a may bill. */
function fixture(
  pr: { headRefOid?: string; mergeable?: string },
  ledger: Ledger,
) {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  withOrigin(w);
  w.setPrs("open", [openPr(7, "feature/7", pr)]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setComments(7, [ledgerComment(701, ledger)]);
  w.setWorkspaces([{ branch: "feature/7", linkedPR: 7, path: ws }]);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  return w;
}

/** PR #7, its drive's ledger written for its workspace's path. */
function treeFixture(ledger: (ws: string) => Ledger): { w: World; ws: string } {
  const w = fixture({ mergeable: "MERGEABLE" }, stop(15, 3));
  const ws = join(w.root, "ws-7");
  w.setComments(7, [ledgerComment(701, ledger(ws))]);
  return { w, ws };
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];
const notified = (r: TickReceipt) =>
  (r.repos[0]?.notifications ?? []).map((n) => [n.target, n.cause, n.outcome]);

/** Run one tick that re-drives PR #7, its drive exiting `driveExit`; wait for the exit. */
async function redrive(w: World, driveExit: number): Promise<string> {
  writeFileSync(join(w.dir, "drive-exit"), String(driveExit));
  const [launched] = launches(await tick(w));
  expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
  const record = launched?.record ?? "";
  await waitFor("the exit", () => exitWritten(w, record));
  return record;
}

describe("jig dispatch --apply re-drives a recovery stop", () => {
  it("re-arms a pass deadline once per head, counted against the budget, then tells a person", async () => {
    const w = fixture({ mergeable: "MERGEABLE" }, stop(15, 3));
    const record = await redrive(w, 15);
    const launched = readRecord(record, dispatchState(w));
    expect(launched?.facts.startsWith("recovery: ")).toBe(true);
    expect(launched?.redrive?.change).toBe(`head ${HEAD_SHA}, stopped 15`);
    w.setComments(7, [ledgerComment(701, stop(15, 4))]);

    const second = await tick(w);
    expect(launches(second)).toEqual([]);
    expect(notified(second)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(second.repos[0]?.actions[0]?.notice?.text).toContain(
      `launch record ${record} already re-drove it for this change and ended 15: only a person settles it until its head moves`,
    );
  }, 180_000);

  it("re-drives a pass deadline that left work only in the tree it stopped in", async () => {
    const leftWork = (actor: (ws: string) => string) => (ws: string) =>
      stop(15, 3, {
        events: [measured(15, true)],
        driver: {
          ...stoppedLedger(7, 15).driver,
          actor: actor(ws),
          clone: `clone-a@${hostLabel()}`,
        },
      });
    const own = treeFixture(leftWork((ws) => `wt-${worktreePathKey(ws)}`));
    const record = await redrive(own.w, 15);
    expect(readRecord(record, dispatchState(own.w))?.workspace?.path).toBe(
      own.ws,
    );
    current?.close();

    // No open workspace holds the tree: a person recovers the work.
    const gone = treeFixture(leftWork(() => "wt-0123456789abcdef"));
    const r = await tick(gone.w);
    expect(launches(r)).toEqual([]);
    expect(notified(r)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(r.repos[0]?.actions[0]?.notice?.text).toContain(
      "which no open workspace on this host holds",
    );
  }, 180_000);

  it("re-arms a failure on a conflicting pull request once per head and base head, then tells a person", async () => {
    const w = fixture({ mergeable: "CONFLICTING" }, stop(1, 3));
    const record = await redrive(w, 1);
    expect(readRecord(record, dispatchState(w))?.redrive?.change).toBe(
      `head ${HEAD_SHA}, base ${BASE_SHA}`,
    );
    w.setComments(7, [ledgerComment(701, stop(1, 4))]);
    const second = await tick(w);
    expect(launches(second)).toEqual([]);
    expect(notified(second)).toEqual([["PR #7", "needs-person", "sent"]]);

    // The base moved: its conflict-resolve round runs again.
    w.setBaseHead(MOVED);
    await redrive(w, 1);
    expect(driveRuns(w)).toHaveLength(2);
  }, 180_000);

  it("spends one budget across a no-cause re-arm, a pass deadline and a conflicting failure", async () => {
    const w = fixture({ mergeable: "MERGEABLE" }, stop(undefined, 2));
    await redrive(w, 0);
    w.setComments(7, [ledgerComment(701, stop(15, 3))]);
    await redrive(w, 15);
    w.setPrs("open", [openPr(7, "feature/7", { mergeable: "CONFLICTING" })]);
    w.setComments(7, [ledgerComment(701, stop(1, 4))]);
    await redrive(w, 1);

    // A deadline at a new head would be re-driven, but the budget is spent.
    w.setPrs("open", [
      openPr(7, "feature/7", { headRefOid: MOVED, mergeable: "MERGEABLE" }),
    ]);
    w.setComments(7, [ledgerComment(701, stop(15, 5))]);
    const fourth = await tick(w);
    expect(launches(fourth)).toEqual([]);
    expect(notified(fourth)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(fourth.repos[0]?.actions[0]?.notice?.text).toContain(
      "repeated recovery re-drives: needs a person; 3 recovery attempts within one hour (budget 3)",
    );
  }, 240_000);
});
