/**
 * dispatch --apply: a silent drive whose driver no launch record or claim
 * started, armed by hand in another clone on this host. Where this host
 * shows that driver's run ended it is taken over, once per ledger facts;
 * where its driver still runs, or its clone is on another host, a person is
 * told, once.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeDriverRecord } from "../../skills/drive-pr/scripts/lib/ledger-stop.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { hostLabel } from "../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { readRecord } from "../lib/launches.ts";
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
  driveRuns,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

/** The other clone on this host the drive was armed in by hand. */
const CLONE = "0123456789abcdef";
const STARTED = "2026-10-30T20:00:00.000Z";

let current: World | null = null;
let sleeper: Bun.Subprocess | null = null;
afterEach(async () => {
  sleeper?.kill("SIGKILL");
  if (sleeper !== null) await sleeper.exited;
  sleeper = null;
  current?.close();
  current = null;
});

/** PR #7's ledger: running, its heartbeat long past the lease window, its driver in clone `clone`. */
function silent(clone: string): Ledger {
  const ledger = stoppedLedger(7, undefined);
  ledger.driver = {
    ...ledger.driver,
    clone,
    started: STARTED,
    recoveryVersion: 1,
    position: 0,
    state: "running",
  };
  return ledger;
}

/** PR #7, its drive silent in `clone`, whose run this host's drive database records with `pid`. */
function fixture(clone: string, pid: number): World {
  const w = world();
  current = w;
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
  );
  withOrigin(w);
  w.setPrs("open", [openPr(7, "feature/7")]);
  w.setComments(7, [ledgerComment(701, silent(clone))]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: "feature/7", linkedPR: 7, path: ws }]);
  const stateDir = join(w.env.DRIVE_PR_STATE_DIR as string, CLONE);
  mkdirSync(stateDir, { recursive: true });
  // The hand-armed driver released its locks; whether its pid still runs is what this host shows.
  writeDriverRecord(stateDir, "7", {
    worktree: join(w.root, "hand-armed"),
    started: STARTED,
    pid,
    host: hostname(),
    released: true,
  });
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  return w;
}

/** A pid no process holds any more. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", ""], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await child.exited;
  return child.pid;
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

const launches = (r: TickReceipt) => r.repos[0]?.launches ?? [];
const notified = (r: TickReceipt) =>
  (r.repos[0]?.notifications ?? []).map((n) => [n.target, n.cause, n.outcome]);

describe("jig dispatch --apply and a silent driver no launch started", () => {
  it("takes it over where this host shows its run ended, once per ledger facts", async () => {
    const w = fixture(`${CLONE}@${hostLabel()}`, await deadPid());
    const first = await tick(w);
    const [launched] = launches(first);
    expect(launched).toMatchObject({ action: "takeover", outcome: "launched" });
    expect(first.repos[0]?.actions[0]?.reason).toContain(
      "no launch started its driver, and this host shows its run ended (its driver released its locks, and its pid",
    );
    const record = launched?.record ?? "";
    await waitFor("the takeover's exit", () => exitWritten(w, record));
    expect(driveRuns(w)[0]?.argv).toContain("--take-over");
    // The takeover draws on the pull request's recovery budget.
    expect(
      readRecord(record, dispatchState(w))?.facts.startsWith("recovery: "),
    ).toBe(true);

    // The takeover ended and left the ledger as it was: a person is told.
    const second = await tick(w);
    expect(launches(second)).toEqual([]);
    expect(notified(second)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(second.repos[0]?.actions[0]?.notice?.text).toContain(
      `launch record ${record} already took it over on these ledger facts`,
    );
  }, 180_000);

  it("tells a person, and does not take it over, while its driver's pid still runs", async () => {
    sleeper = Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      { stdout: "ignore", stderr: "ignore" },
    );
    const w = fixture(`${CLONE}@${hostLabel()}`, sleeper.pid);
    const r = await tick(w);
    expect(launches(r)).toEqual([]);
    expect(notified(r)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(r.repos[0]?.actions[0]?.evidence).toMatchObject({
      driverGone: false,
      driverCheck: expect.stringContaining("still runs"),
    });
    expect(driveRuns(w)).toEqual([]);
  }, 90_000);

  it("tells a person once, and does not take it over, when its driver's clone is on another host", async () => {
    const w = fixture(`${CLONE}@ffffffffffffffff`, await deadPid());
    const r = await tick(w);
    expect(launches(r)).toEqual([]);
    expect(notified(r)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(r.repos[0]?.actions[0]?.evidence?.driverCheck).toContain(
      "is not on this host",
    );
    const again = await tick(w);
    expect(launches(again)).toEqual([]);
    expect(notified(again)).toEqual([["PR #7", "needs-person", "suppressed"]]);
    expect(driveRuns(w)).toEqual([]);
  }, 90_000);
});
