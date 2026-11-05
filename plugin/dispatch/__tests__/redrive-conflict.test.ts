/**
 * dispatch --apply: a drive that stopped `9` (still conflicting with its base
 * once its conflict-repair budget was spent) is re-armed once per change, the
 * pair of its pull request's head and its base branch's head; a person is
 * told only once this machine's re-drive leaves the ledger stopped `9` at the
 * same change, and a head or a base that moves is a new attempt.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { readRecord } from "../lib/launches.ts";
import { type EndedRow, readRows } from "../lib/log.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  BASE_SHA,
  HEAD_SHA,
  labeled,
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
  terminalCreates,
  waitFor,
} from "./launch-fixtures.ts";

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
`;
const LABELS_ON = `${CONFIG}dispatch:
  labels: { enabled: true }
`;

const HEAD = "feature/7-conflict";
const MOVED = "b".repeat(40);
const BASE_MOVED = "d".repeat(40);
const CHANGE = `head ${HEAD_SHA}, base ${BASE_SHA}`;
const STILL = "stopped on a conflict with its base, and still conflicting";
const GONE =
  "stopped on a conflict with its base, which the forge no longer reports";

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** The ledger as a drive that just stopped wrote it: its heartbeat now, so the stop falls inside the launch that made it. */
function stop(
  exit: number,
  generation: number,
  extra: Partial<Ledger> = {},
): Ledger {
  const ledger = stoppedLedger(7, exit, extra);
  return {
    ...ledger,
    generation,
    driver: { ...ledger.driver, heartbeat: new Date().toISOString() },
  };
}

/** PR #7, whose drive stopped `exit` (`9` unless a test says otherwise), as the forge now lists it; its workspace exists, and account a may bill. */
function fixture(
  pr: { headRefOid?: string; mergeable?: string; labels?: unknown[] },
  { yaml = CONFIG, exit = 9 }: { yaml?: string; exit?: number } = {},
): World {
  const w = world();
  current = w;
  w.setConfig(yaml);
  w.setPrs("open", [openPr(7, HEAD, pr)]);
  w.setComments(7, [
    ledgerComment(701, stoppedLedger(7, exit, { verifiedSha: HEAD_SHA })),
  ]);
  const ws = join(w.root, "ws-7");
  mkdirSync(ws, { recursive: true });
  w.setWorkspaces([{ branch: HEAD, linkedPR: 7, path: ws }]);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  return w;
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
async function redrive(w: World, driveExit = 9): Promise<string> {
  writeFileSync(join(w.dir, "drive-exit"), String(driveExit));
  const [launched] = launches(await tick(w));
  expect(launched).toMatchObject({ action: "rearm", outcome: "launched" });
  const record = launched?.record ?? "";
  await waitFor("the exit", () => exitWritten(w, record));
  return record;
}

const baseReads = (w: World) => {
  const log = join(w.dir, "base-reads.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
};

describe("jig dispatch --apply re-drives a drive that stopped on a conflict", () => {
  it("re-arms once per change, on the pull request's head and its base branch's head", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    const record = await redrive(w);
    expect(readRecord(record, dispatchState(w))?.redrive).toEqual({
      cause: STILL,
      change: CHANGE,
      conflictStop: true,
    });
    expect(driveRuns(w)).toHaveLength(1);
  }, 90_000);

  it("tells a person once when its own re-drive stops 9 at the same change, and launches nothing more", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    const record = await redrive(w);
    w.setComments(7, [ledgerComment(701, stop(9, 4))]);

    const second = await tick(w);
    expect(launches(second)).toEqual([]);
    expect(notified(second)).toEqual([["PR #7", "needs-person", "sent"]]);
    const [action] = second.repos[0]?.actions ?? [];
    expect(action).toMatchObject({ stage: "notify", launched: true });
    expect(action?.notice?.text).toContain(
      `launch record ${record} already re-drove it for this change and ended 9: only a person settles it until its head or its base moves`,
    );

    const third = await tick(w);
    expect(launches(third)).toEqual([]);
    expect(notified(third)).toEqual([["PR #7", "needs-person", "suppressed"]]);
    expect(terminalCreates(w)).toHaveLength(1);
  }, 90_000);

  it("makes a new attempt when the base moves, and when the head moves, and tells a person of each stop", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    await redrive(w);
    w.setComments(7, [ledgerComment(701, stop(9, 4))]);
    expect(notified(await tick(w))).toEqual([
      ["PR #7", "needs-person", "sent"],
    ]);

    w.setBaseHead(BASE_MOVED);
    const again = await redrive(w);
    expect(readRecord(again, dispatchState(w))?.redrive?.change).toBe(
      `head ${HEAD_SHA}, base ${BASE_MOVED}`,
    );
    w.setComments(7, [ledgerComment(701, stop(9, 5))]);
    expect(notified(await tick(w))).toEqual([
      ["PR #7", "needs-person", "sent"],
    ]);

    w.setPrs("open", [
      openPr(7, HEAD, { headRefOid: MOVED, mergeable: "CONFLICTING" }),
    ]);
    const third = await redrive(w);
    expect(readRecord(third, dispatchState(w))?.redrive?.change).toBe(
      `head ${MOVED}, base ${BASE_MOVED}`,
    );
    expect(driveRuns(w)).toHaveLength(3);
  }, 180_000);

  it("re-drives a stop the forge no longer reports conflicting, once per change, and its rounds take it from there", async () => {
    const w = fixture({});
    const record = await redrive(w, 0);
    expect(readRecord(record, dispatchState(w))?.redrive).toEqual({
      cause: GONE,
      change: CHANGE,
      conflictStop: true,
    });
    // Its rounds converged at this head: the stop is gone, and nothing more is owed.
    w.setComments(7, [
      ledgerComment(701, stop(0, 4, { verifiedSha: HEAD_SHA })),
    ]);
    const later = await tick(w);
    expect(launches(later)).toEqual([]);
    expect(later.repos[0]?.actions).toEqual([]);
    expect(later.repos[0]?.quiet).toContainEqual({
      target: "PR #7",
      class: "done",
      why: "stopped 0 (converged), still at the verified head aaaaaaa and mergeable",
    });
  }, 90_000);

  it("gives a converged re-drive that stops 9 one more attempt under the new key, then tells a person", async () => {
    const w = fixture({ mergeable: "CONFLICTING" }, { exit: 0 });
    const first = await redrive(w);
    expect(readRecord(first, dispatchState(w))?.redrive?.change).toBe(
      `head ${HEAD_SHA}, conflicting`,
    );
    w.setComments(7, [ledgerComment(701, stop(9, 4))]);

    const second = await redrive(w);
    expect(readRecord(second, dispatchState(w))?.redrive?.change).toBe(CHANGE);
    w.setComments(7, [ledgerComment(701, stop(9, 5))]);

    const third = await tick(w);
    expect(launches(third)).toEqual([]);
    expect(notified(third)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(driveRuns(w)).toHaveLength(2);
  }, 120_000);

  it("reads another exit of a re-drive as the table says for that exit", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    const record = await redrive(w, 1);
    w.setComments(7, [ledgerComment(701, stop(1, 4))]);
    const failed = await tick(w);
    expect(launches(failed)).toEqual([]);
    expect(notified(failed)).toEqual([["PR #7", "needs-person", "sent"]]);
    expect(failed.repos[0]?.actions[0]?.notice?.text).toContain("stopped 1");

    // A person stops it: never re-armed, whatever change the record re-drove.
    w.setComments(7, [ledgerComment(701, stop(18, 5))]);
    const stopped = await tick(w);
    expect(launches(stopped)).toEqual([]);
    expect(stopped.repos[0]?.quiet).toContainEqual({
      target: "PR #7",
      class: "stopped-by-person",
      why: "stopped 18 (a mailbox stop): a person's stop is never re-armed",
    });
    expect(readRecord(record, dispatchState(w))?.redrive?.change).toBe(CHANGE);
    expect(driveRuns(w)).toHaveLength(1);
  }, 90_000);

  it("tells a person when its re-drive ended without a stop of its own, the ledger still stopped 9", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    // The drive refused before it took the ledger: the older stop still stands.
    const record = await redrive(w, 2);
    const later = await tick(w);
    expect(launches(later)).toEqual([]);
    expect(notified(later)).toEqual([["PR #7", "needs-person", "sent"]]);
    const [action] = later.repos[0]?.actions ?? [];
    expect(action?.launched).toBeUndefined();
    expect(action?.notice?.text).toContain(
      `launch record ${record} already re-drove it for this change and ended 2`,
    );
    expect(terminalCreates(w)).toHaveLength(1);
  }, 90_000);

  it("reports, never relaunches, a re-drive drive.ts refused on the same facts", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    const record = await redrive(w, 11);
    const later = await tick(w);
    expect(launches(later)).toEqual([]);
    expect(later.repos[0]?.actions).toEqual([]);
    expect(later.repos[0]?.quiet).toContainEqual({
      target: "PR #7",
      class: "refused",
      why: `launch record ${record} ended 11, drive.ts's refusal, on these same ledger facts; it is not launched again until they change`,
    });
  }, 90_000);

  it("launches nothing when the base moved between the plan's read and the launch's, and re-drives the new change at the next tick", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    w.setBaseHead(BASE_SHA, BASE_MOVED);
    const [waited] = launches(await tick(w));
    expect(waited).toMatchObject({ outcome: "waits" });
    expect(waited?.detail).toContain("changed since the plan read it");
    expect(terminalCreates(w)).toEqual([]);

    const record = await redrive(w);
    expect(readRecord(record, dispatchState(w))?.redrive?.change).toBe(
      `head ${HEAD_SHA}, base ${BASE_MOVED}`,
    );
  }, 90_000);

  it("replays a re-drive whose launch answer was lost, though the base moved since: nothing else would drive it", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    machineFile(
      w,
      [account(w, "a", "a@example.com")],
      { runtime_timeout: "2s" },
      ["rearm", "notify"],
    );
    writeFileSync(join(w.dir, "orca-terminal-hang"), "");
    const [lost] = launches(await tick(w));
    expect(lost?.outcome).toBe("lost");
    rmSync(join(w.dir, "orca-terminal-hang"));

    w.setBaseHead(BASE_MOVED);
    const [replayed] = launches(await tick(w));
    expect(replayed).toMatchObject({
      outcome: "retried",
      record: lost?.record,
    });
    await waitFor("the exit", () => exitWritten(w, lost?.record ?? ""));
  }, 90_000);

  it("logs a re-drive's end with a reason that says it was a conflict", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    const record = await redrive(w);
    await tick(w);
    const rows = readRows(undefined, undefined, dispatchState(w)).filter(
      (r): r is EndedRow => r.kind === "ended",
    );
    expect(rows.map((r) => [r.record, r.class, r.reason])).toEqual([
      [
        record,
        "gates failed",
        `exit 9 (conflicting with its base); re-drive of a drive that stopped on a conflict: ${STILL}`,
      ],
    ]);
  }, 90_000);

  it("reads a base branch once a tick however many pull requests stand on it, and only for a ledger that stopped 9", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    w.setPrs("open", [
      openPr(7, HEAD, { mergeable: "CONFLICTING" }),
      openPr(8, "feature/8", { mergeable: "CONFLICTING" }),
      openPr(9, "feature/9"),
    ]);
    w.setComments(8, [ledgerComment(801, stoppedLedger(8, 9))]);
    w.setComments(9, [ledgerComment(901, stoppedLedger(9, 1))]);
    machineFile(w, [account(w, "a", "a@example.com")], {}, []);
    const r = await w.dispatch(["--json"]);
    expectSpawnExit(r, 0);
    expect(baseReads(w)).toEqual([`repos/${SLUG}/git/ref/heads/main`]);
  });
});

describe("a stop 9 the tick cannot place", () => {
  const unplacedOf = async (w: World) => {
    const receipt = await tick(w);
    expect(launches(receipt)).toEqual([]);
    expect(terminalCreates(w)).toEqual([]);
    return receipt.repos[0]?.unplaced.map((u) => u.reason).join("\n") ?? "";
  };

  it("waits while the forge computes its mergeability", async () => {
    const w = fixture({ mergeable: "UNKNOWN" });
    expect(await unplacedOf(w)).toContain(
      "the forge is still computing whether it conflicts with its base",
    );
  });

  it("waits when its head commit does not read", async () => {
    const w = fixture({ mergeable: "CONFLICTING", headRefOid: "" });
    expect(await unplacedOf(w)).toContain(
      "the forge reports no head commit for it",
    );
  });

  it("waits when its base branch's head does not read", async () => {
    const w = fixture({ mergeable: "CONFLICTING" });
    w.setBaseHead(null);
    expect(await unplacedOf(w)).toContain(
      "the head of its base branch does not read",
    );
  });
});

describe("a stop 9 under dispatch labels", () => {
  const stateOf = (r: TickReceipt) =>
    r.repos[0]?.labels?.states.find((s) => s.target === "PR #7")?.state;

  it("carries stale while a re-drive is owed, and parked once only a person settles it", async () => {
    const w = fixture({ mergeable: "CONFLICTING" }, { yaml: LABELS_ON });
    writeFileSync(join(w.dir, "drive-exit"), "9");
    const first = await tick(w);
    const record = launches(first)[0]?.record ?? "";
    expect(stateOf(first)).toBe("stale");
    await waitFor("the exit", () => exitWritten(w, record));

    w.setComments(7, [ledgerComment(701, stop(9, 4))]);
    expect(stateOf(await tick(w))).toBe("parked");
  }, 90_000);

  it("stands down for a person's hold label", async () => {
    const w = fixture(
      labeled({ mergeable: "CONFLICTING" }, "jig:hold") as {
        mergeable: string;
        labels: unknown[];
      },
      { yaml: LABELS_ON },
    );
    const receipt = await tick(w);
    expect(launches(receipt)).toEqual([]);
    expect(receipt.repos[0]?.labels?.held).toMatchObject([
      { target: "PR #7", stage: "rearm" },
    ]);
    expect(terminalCreates(w)).toEqual([]);
  });
});
