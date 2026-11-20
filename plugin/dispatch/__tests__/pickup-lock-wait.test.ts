/**
 * A claimed pickup whose push the pre-push hook refused only because its
 * wait for the host's test lock ran out records `waits --reason test-lock`
 * and asks nothing. The tick relaunches it in its tree to push and go on,
 * held while the host's validation capacity has no room whatever
 * `load.enforce` says; past `LOCK_WAIT_BOUND` lock waits in a row it is one
 * need for a repair session or a person.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { pickupHold } from "../lib/actions/pickup-hold.ts";
import {
  type LaunchRecord,
  type ReadRecord,
  readEnded,
  readRecord,
  recordExit,
} from "../lib/launches.ts";
import { LOAD_DEFAULTS } from "../lib/load-config.ts";
import type { LoadReading } from "../lib/load-read.ts";
import {
  type LoadState,
  holdsReplay,
  judge,
  loadState,
  VALIDATION_GAUGES,
} from "../lib/load.ts";
import type { ValidationLoad } from "../lib/validation-load.ts";
import { LOCK_WAIT_BOUND } from "../lib/pickup-lock-wait.ts";
import type { PickupTree } from "../lib/pickup-tree.ts";
import { type PickupInput, planPickups } from "../lib/plan-pickups.ts";
import type { Workspace } from "../lib/runtime/port.ts";
import { pickupPassArgv } from "../lib/session.ts";
import type { ClaimedItem, DispatchSection, WantedItem } from "../lib/types.ts";
import { measureValidation } from "../lib/validation-capacity.ts";
import { readWaitFor } from "../lib/wait-for.ts";
import { resultMain } from "../result.ts";
import {
  currentIso,
  currentMs,
  isoFromMs,
  parseMs,
} from "../../shared/time.ts";
import type { TickReceipt } from "../receipts.ts";
import { assignedIssue, SLUG, type World, world } from "./fixtures.ts";
import {
  account,
  dispatchState,
  earlierRecord,
  exitWritten,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { applyTick, claudeRuns, withOrigin } from "./pickup-fixtures.ts";

const NOW = parseMs("2026-11-20T10:00:00Z");
const HOUR = 3_600_000;
const PATH = "/work/w12";
const HEAD = "1".repeat(40);
const SOURCE = "20261120T080000Z-aaaaaaaa";
const ITEM: ClaimedItem = { key: "#12", title: "task", state: "In Progress" };

/** A headless pickup of #12 in `PATH` whose pass recorded that the host's test lock held its push. */
function lockWaited(
  extra: Partial<LaunchRecord> = {},
  until = "2026-11-20T08:30:00.000Z",
): ReadRecord {
  return {
    record: {
      id: SOURCE,
      token: "t",
      action: "pickup",
      repo: SLUG,
      item: "#12",
      pr: null,
      headless: true,
      released: false,
      claimedItems: ["#12"],
      createdAt: "2026-11-20T08:00:00.000Z",
      workspace: { id: "w12", path: PATH },
      account: "a",
      ...extra,
    } as unknown as LaunchRecord,
    state: {
      kind: "ended",
      exit: { at: "2026-11-20T08:31:00Z", code: 0, signal: null },
      process: null,
    },
    result: "waits",
    waitsUntil: until,
    waitsFor: { reason: "test-lock" },
  };
}

/** The `n`th lock-wait relaunch along the chain from `SOURCE`, at the same head. */
function relaunchOf(n: number): ReadRecord {
  return lockWaited({
    id: `20261120T09${n}000Z-bbbbbbb${n}`,
    createdAt: `2026-11-20T09:${n}0:00.000Z`,
    relaunchOf: n === 1 ? SOURCE : `20261120T09${n - 1}000Z-bbbbbbb${n - 1}`,
    relaunchHead: HEAD,
    relaunchLockWait: true,
  });
}

const unpushed = (): PickupTree => ({
  kind: "read",
  head: HEAD,
  unpushed: 1,
  uncommitted: 0,
});

const open: Workspace = {
  id: "w12",
  path: PATH,
  branch: "12-task",
  items: ["#12"],
  prs: [],
  agents: [],
  unverifiableTerminals: 0,
  comment: "",
  unread: null,
  name: "w12",
};

function plan(launches: ReadRecord[], batch = false) {
  const input: PickupInput = {
    slug: SLUG,
    section: {
      stalledAfterMs: HOUR,
      blockedAfterMs: HOUR,
      stalledScope: "claimed",
      stalledRelaunch: "finish-once",
    } as DispatchSection,
    pickups: [],
    claimed: [ITEM],
    sessions: { ok: true, source: "fake", workspaces: [open] },
    launches: batch
      ? launches.map((r) => ({
          ...r,
          record: {
            ...r.record,
            batchItems: [
              { key: "#12", person: "writer" },
              { key: "#13", person: "writer" },
            ],
          } as LaunchRecord,
        }))
      : launches,
    // Idle for a minute only: a lock wait does not wait for stalled_after.
    idleSince: new Map([["#12", NOW - 60_000]]),
    nowMs: NOW,
    trees: unpushed,
    rerunsHeld: null,
  };
  return planPickups(input);
}

const relaunches = (p: ReturnType<typeof planPickups>) =>
  p.actions.filter((a) => a.relaunch !== undefined);
const needs = (p: ReturnType<typeof planPickups>) =>
  p.actions.filter((a) => a.stage === "notify");

describe("a claimed pickup whose push the host's test lock held", () => {
  it("is not raised as a need, and is relaunched in its tree to push without waiting for stalled_after", () => {
    const p = plan([lockWaited()]);
    expect(needs(p)).toEqual([]);
    expect(relaunches(p)).toEqual([
      expect.objectContaining({
        target: "#12",
        stage: "pickup",
        reason: expect.stringContaining("host's test lock"),
        relaunch: {
          record: SOURCE,
          workspace: { id: "w12", path: PATH },
          head: HEAD,
          lockWait: true,
        },
      }),
    ]);
  });

  it("is relaunched again at the same head while its lock waits stay under the bound", () => {
    const p = plan([lockWaited(), relaunchOf(1)]);
    expect(needs(p)).toEqual([]);
    expect(relaunches(p)).toEqual([
      expect.objectContaining({
        relaunch: expect.objectContaining({
          record: relaunchOf(1).record.id,
          head: HEAD,
          lockWait: true,
        }),
      }),
    ]);
  });

  it("waits until the time its pass named before it is relaunched", () => {
    const p = plan([lockWaited({}, "2026-11-20T10:20:00.000Z")]);
    expect(p.actions).toEqual([]);
    expect(p.quiet).toContainEqual({
      target: "#12",
      class: "pickup-ended",
      why: expect.stringContaining("until 2026-11-20T10:20:00.000Z"),
    });
  });

  it("is held, not picked up afresh, while it waits", () => {
    const hold = pickupHold("#12", [lockWaited()], undefined, NOW);
    expect(hold).toMatchObject({
      kind: "held",
      why: expect.stringContaining("waits for the host's test lock"),
    });
  });

  it("relaunches no batch's pickup, whose stop stays a person's", () => {
    const p = plan([lockWaited()], true);
    expect(relaunches(p)).toEqual([]);
  });
});

describe("a pickup the host's test lock refuses again past the bound", () => {
  it(`raises one need for a repair session after ${LOCK_WAIT_BOUND} lock waits in a row, and no further relaunch`, () => {
    const chain = [lockWaited(), relaunchOf(1), relaunchOf(2)];
    expect(chain).toHaveLength(LOCK_WAIT_BOUND);
    const last = relaunchOf(2).record.id;
    const p = plan(chain);
    expect(relaunches(p)).toEqual([]);
    expect(needs(p)).toEqual([
      expect.objectContaining({
        target: "#12",
        cause: "pickup-ended",
        reason: expect.stringContaining(
          `held by the host's test lock ${LOCK_WAIT_BOUND} times in a row`,
        ),
        evidence: expect.objectContaining({
          record: last,
          tree: PATH,
          lockWaits: [last, relaunchOf(1).record.id, SOURCE].join(", "),
        }),
        notice: expect.objectContaining({
          key: expect.stringContaining(`record ${last}`),
        }),
        workspace: PATH,
      }),
    ]);
  });
});

describe("a test-lock wait from a pass that claimed nothing", () => {
  const BATCH = [
    { key: "#12", person: "writer" },
    { key: "#13", person: "writer" },
  ];
  const wanted = (key: string): WantedItem => ({
    key,
    title: "task",
    url: null,
    state: "Todo",
    assignee: "factory",
    assignedBy: "writer",
  });

  /** The tick's plan for `keys`, still in a dispatch state, claimed by nobody. */
  function unclaimedPlan(launches: ReadRecord[], keys: string[]) {
    return planPickups({
      slug: SLUG,
      section: {
        stalledAfterMs: HOUR,
        blockedAfterMs: HOUR,
        stalledScope: "claimed",
        stalledRelaunch: "finish-once",
      } as DispatchSection,
      pickups: keys.map(wanted),
      claimed: [],
      sessions: { ok: true, source: "fake", workspaces: [open] },
      launches,
      idleSince: new Map(),
      nowMs: NOW,
      trees: unpushed,
      rerunsHeld: null,
    });
  }

  it("holds a lone item as any end does, a need for a person, never as a wait for a relaunch", () => {
    const record = lockWaited({ claimedItems: [] });
    expect(pickupHold("#12", [record], undefined, NOW)).toMatchObject({
      kind: "ended",
    });
    const p = unclaimedPlan([record], ["#12"]);
    expect(p.running).toEqual([]);
    expect(relaunches(p)).toEqual([]);
    expect(needs(p)).toEqual([
      expect.objectContaining({ target: "#12", cause: "pickup-ended" }),
    ]);
  });

  it("strands no member of a batch that claimed none", () => {
    const record = lockWaited({
      claimedItems: [],
      batchItems: BATCH,
    } as Partial<LaunchRecord>);
    for (const key of ["#12", "#13"])
      expect(pickupHold(key, [record], undefined, NOW)).toMatchObject({
        kind: "ended",
      });
    const p = unclaimedPlan([record], ["#12", "#13"]);
    expect(p.running).toEqual([]);
    expect(relaunches(p)).toEqual([]);
    expect(needs(p).map((a) => a.target)).toEqual(["#12", "#13"]);
  });
});

describe("the validation gauge's hold on a lock-wait relaunch", () => {
  const reading: LoadReading = {
    host: { load1: 1, cores: 8, availableBytes: 12 * 1024 ** 3 },
    totalBytes: 16 * 1024 ** 3,
    platform: "linux",
    disk: {
      freeBytes: 500 * 1024 ** 3,
      totalBytes: 1000 * 1024 ** 3,
      path: "/",
    },
    lock: { holders: 1, waiters: 0 },
    forge: { remaining: 4000, limit: 5000 },
    sessions: new Map(),
  };
  const withDemand = (
    atLock: number,
  ): LoadState & { validation: ValidationLoad } => {
    const load = loadState(
      LOAD_DEFAULTS,
      { ...reading, host: { ...reading.host } },
      { held: 0, capacity: 8 },
      new Map(),
    );
    const validation: ValidationLoad = {
      measured: measureValidation([], []),
      demand: { atLock, toArrive: 0 },
      waitLimitMs: HOUR,
      waitSource: "LOCK_TIMEOUT",
      driveDeadlineMs: 3 * HOUR,
      admittedRuns: 0,
    };
    load.validation = validation;
    return Object.assign(load, { validation });
  };

  it("holds it without load.enforce while the validation capacity has no room, and reports the hold", () => {
    const load = withDemand(40);
    expect(LOAD_DEFAULTS.enforce).toBe(false);
    expect(
      judge(load, "pickup", SLUG, "#12", 3 * HOUR, VALIDATION_GAUGES),
    ).toContain("the host's validation capacity holds it");
    expect(load.holds).toMatchObject([
      { target: "#12", kind: "pickup", gauge: "validation", held: true },
    ]);
    // Any other launch the gauge would refuse still starts without enforcement.
    expect(judge(load, "pickup", SLUG, "#13", 3 * HOUR)).toBeNull();
  });

  it("counts the validation runs of a pinned relaunch an advisory gauge lets start", () => {
    const load = withDemand(0);
    load.validation.demand = { atLock: 0, toArrive: 0 };
    // Memory over its line refuses the launch advisorily; it still starts and still validates.
    load.reading.host.availableBytes = 0;
    const before = load.validation.admittedRuns;
    expect(
      judge(load, "pickup", SLUG, "#12", 3 * HOUR, VALIDATION_GAUGES),
    ).toBeNull();
    expect(load.holds.length).toBeGreaterThan(0);
    expect(load.validation.admittedRuns).toBeGreaterThan(before);
  });

  it("counts the validation runs of any launch an advisory gauge lets start", () => {
    const load = withDemand(0);
    load.reading.host.availableBytes = 0;
    expect(judge(load, "pickup", SLUG, "#12", 3 * HOUR)).toBeNull();
    expect(load.holds.length).toBeGreaterThan(0);
    expect(load.validation.admittedRuns).toBeGreaterThan(0);
  });

  it("judges a pending replay without charging its own reserved runs again", () => {
    const own = withDemand(0).validation.measured.kinds.pickup.runsPerPass;
    // The wait window permits four runs: the replay's own reserved run
    // is the one that fills it, so it is admitted only once subtracted.
    const room = 4;
    const atBoundary = withDemand(0);
    atBoundary.validation.demand = { atLock: 0, toArrive: room - 1 + own };
    expect(
      holdsReplay(
        atBoundary,
        "pickup",
        SLUG,
        "#12",
        3 * HOUR,
        VALIDATION_GAUGES,
      ),
    ).toBeNull();
    expect(atBoundary.validation.admittedRuns).toBe(0);
    expect(atBoundary.holds).toEqual([]);
    // One run more in the forecast and the replay waits, and says so.
    const over = withDemand(0);
    over.validation.demand = { atLock: 0, toArrive: room + own };
    expect(
      holdsReplay(over, "pickup", SLUG, "#12", 3 * HOUR, VALIDATION_GAUGES),
    ).toContain("the host's validation capacity holds it");
    expect(over.holds).toMatchObject([
      { target: "#12", kind: "pickup", gauge: "validation", held: true },
    ]);
  });

  it("forecasts a lock-wait relaunch as reaching the lock at once, without the pickup's delay", () => {
    const first = Array.from({ length: 80 }, (_, atLock) => atLock).find(
      (atLock) =>
        judge(
          withDemand(atLock),
          "pickup",
          SLUG,
          "#12",
          3 * HOUR,
          VALIDATION_GAUGES,
        ) !== null,
    );
    expect(first).toBeDefined();
    const room = Array.from({ length: first as number }, (_, n) => n).find(
      (atLock) =>
        judge(
          withDemand(atLock),
          "pickup",
          SLUG,
          "#12",
          3 * HOUR,
          VALIDATION_GAUGES,
          true,
        ) !== null,
    );
    // Some occupancy the delayed pickup is admitted at holds the immediate one.
    expect(room).toBeDefined();
    const load = withDemand(room as number);
    expect(
      holdsReplay(load, "pickup", SLUG, "#12", 3 * HOUR, VALIDATION_GAUGES),
    ).toBeNull();
    expect(
      holdsReplay(
        load,
        "pickup",
        SLUG,
        "#12",
        3 * HOUR,
        VALIDATION_GAUGES,
        true,
      ),
    ).toContain("the host's validation capacity holds it");
  });

  it("applies the immediate forecast under enforcement as it does without it", () => {
    const hold = (enforce: boolean, atLock: number) => {
      const load = withDemand(atLock);
      load.settings = { ...load.settings, enforce };
      return judge(
        load,
        "pickup",
        SLUG,
        "#12",
        3 * HOUR,
        enforce ? [] : VALIDATION_GAUGES,
        true,
      );
    };
    const room = Array.from({ length: 80 }, (_, n) => n).find(
      (atLock) => hold(false, atLock) !== null,
    );
    expect(room).toBeDefined();
    expect(hold(true, room as number)).not.toBeNull();
    expect(hold(true, 0)).toBeNull();
  });

  it("admits it when the validation capacity has room, or when the gauge does not read", () => {
    expect(
      judge(withDemand(0), "pickup", SLUG, "#12", 3 * HOUR, VALIDATION_GAUGES),
    ).toBeNull();
    const unread = withDemand(0);
    if (unread.validation !== undefined)
      unread.validation.demand = { unread: "the lock was not read" };
    expect(
      judge(unread, "pickup", SLUG, "#12", 3 * HOUR, VALIDATION_GAUGES),
    ).toBeNull();
  });
});

describe("the pickup's prompt", () => {
  const record = {
    ...lockWaited().record,
    id: "20261120T091000Z-bbbbbbb1",
    vendor: "claude",
  } as LaunchRecord;

  it("offers the test-lock wait as a result, with no question", () => {
    const prompt = pickupPassArgv(record, []).at(-1) ?? "";
    expect(prompt).toContain(
      "the pre-push hook refused the push only because its wait for the host's test lock ran out",
    );
    expect(prompt).toContain(
      `jig.ts dispatch result ${record.id} t waits --reason test-lock; ask no question`,
    );
  });

  it("offers no test-lock wait to a batch, which is never relaunched", () => {
    const batch = {
      ...record,
      batchItems: [
        { key: "#12", person: "writer" },
        { key: "#13", person: "writer" },
      ],
    } as LaunchRecord;
    const prompt = pickupPassArgv(batch, []).at(-1) ?? "";
    expect(prompt).toContain("dispatch result");
    expect(prompt).not.toContain("--reason test-lock");
  });

  it("gives a lock-wait relaunch the push-and-go-on prompt, under the earlier claim", () => {
    const prompt =
      pickupPassArgv(
        {
          ...record,
          relaunchOf: SOURCE,
          relaunchHead: HEAD,
          relaunchLockWait: true,
        },
        [],
      ).at(-1) ?? "";
    expect(prompt).toContain(`This pass continues the pickup ${SOURCE} of #12`);
    expect(prompt).toContain("the hook runs again; never bypass it");
    expect(prompt).toContain("make no second claim");
    expect(prompt).not.toContain("This pass finishes the stalled pickup");
  });
});

describe("jig dispatch result … waits --reason test-lock", () => {
  let current: World | null = null;
  afterEach(() => {
    if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
    current?.close();
    current = null;
  });

  function records(w: World): string {
    current = w;
    earlierRecord(w, {
      id: "20261120T080000Z-cccccccc",
      account: "a",
      action: "pickup",
      pr: null,
      item: "#12",
      claimedItems: ["#12"],
    });
    earlierRecord(w, {
      id: "20261120T080100Z-dddddddd",
      account: "a",
      action: "followup",
      pr: 7,
    });
    earlierRecord(w, {
      id: "20261120T080200Z-eeeeeeee",
      account: "a",
      action: "pickup",
      pr: null,
      item: "#12",
      batchItems: [
        { key: "#12", person: "writer" },
        { key: "#13", person: "writer" },
      ],
    } as Parameters<typeof earlierRecord>[1]);
    return dispatchState(w);
  }

  it("is accepted for a claimed pickup's record, with no time needed, and read back as a test-lock wait", () => {
    const root = records(world());
    const id = "20261120T080000Z-cccccccc";
    const before = currentMs();
    expect(
      resultMain([id, "earlier-token", "waits", "--reason", "test-lock"], root),
    ).toBe(0);
    recordExit(id, { at: currentIso(), code: 0, signal: null }, root);
    const ended = readEnded(id, root);
    expect(ended?.result).toBe("waits");
    expect(ended?.waitsFor).toEqual({ reason: "test-lock" });
    expect(parseMs(ended?.waitsUntil ?? "")).toBeGreaterThanOrEqual(
      before - 1000,
    );
    expect(ended?.next).toEqual({
      none: expect.stringContaining("waits for the host's test lock"),
    });
    expect(readWaitFor(JSON.stringify({ reason: "test-lock" }))).toEqual({
      reason: "test-lock",
    });
  });

  it("is refused for a follow-up's or a batch's record, beside --arm, and with a time too far ahead", () => {
    const root = records(world());
    const far = isoFromMs(currentMs() + 3 * 24 * HOUR);
    const pickup = "20261120T080000Z-cccccccc";
    for (const other of [
      "20261120T080100Z-dddddddd",
      "20261120T080200Z-eeeeeeee",
    ])
      expect(
        resultMain(
          [other, "earlier-token", "waits", "--reason", "test-lock"],
          root,
        ),
      ).toBe(2);
    for (const extra of [
      ["--arm", "release"],
      ["--until", far],
    ])
      expect(
        resultMain(
          [pickup, "earlier-token", "waits", "--reason", "test-lock", ...extra],
          root,
        ),
      ).toBe(2);
    expect(readEnded(pickup, root)?.result ?? null).toBeNull();
  });
});

describe("a lock-wait relaunch, through the tick", () => {
  const BRANCH = "12-issue-12";
  let current: World | null = null;
  afterEach(() => {
    if (current !== null) writeFileSync(join(current.dir, "claude-exit"), "");
    current?.close();
    current = null;
  });

  function commit(cwd: string, file: string): void {
    for (const args of [
      ["add", file],
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-q",
        "-m",
        "work",
      ],
    ]) {
      const r = Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
      });
      expectSpawnExit(r, 0, `git ${args.join(" ")}`);
    }
  }

  /** The host the tick reads: idle, with `waiters` runs waiting on the test lock. */
  function host(w: World, waiters: number): Record<string, string> {
    const path = join(w.root, `load-reading-${waiters}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        load1: 1,
        cores: 8,
        totalBytes: 16 * 1024 ** 3,
        availableBytes: 12 * 1024 ** 3,
        diskFreeBytes: 500 * 1024 ** 3,
        diskTotalBytes: 1000 * 1024 ** 3,
        lockHolders: waiters === 0 ? 0 : 1,
        lockWaiters: waiters,
      }),
    );
    return { JIG_DISPATCH_LOAD_READING: path };
  }

  async function tick(
    w: World,
    extra: Record<string, string>,
  ): Promise<TickReceipt> {
    const r = await w.dispatch(["--apply", "--json"], undefined, extra);
    expectSpawnExit(r, 0);
    return JSON.parse(r.stdout) as TickReceipt;
  }

  it("is held while the validation gauge has no room, without load.enforce, and relaunched in its tree when it has room", async () => {
    const w = world();
    current = w;
    w.setConfig(`issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
`);
    w.setIssues([assignedIssue(12, "factory-bot", [])]);
    w.setAssigner(12, "maintainer", "WRITE");
    withOrigin(w);
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["pickup"]);
    const [launched] = (await applyTick(w, false)).repos[0]?.launches ?? [];
    const id = String(launched?.record);
    const root = dispatchState(w);
    const source = readRecord(id, root);
    const path = source?.workspace?.path ?? "";
    await waitFor("the pass", () => claudeRuns(w).length === 1);
    w.setIssues([assignedIssue(12, "factory-bot", ["In Progress"])]);
    expect(
      resultMain(
        [id, source?.token ?? "", "waits", "--reason", "test-lock"],
        root,
      ),
    ).toBe(0);
    writeFileSync(join(w.dir, "claude-exit"), "0");
    await waitFor("the exit", () => exitWritten(w, id));
    w.setWorkspaces([{ branch: BRANCH, path, agents: [] }]);
    writeFileSync(join(path, "work.txt"), "work\n");
    commit(path, "work.txt");

    const full = (await tick(w, host(w, 40))).repos[0];
    expect(full?.actions.filter((a) => a.stage === "notify")).toEqual([]);
    expect(full?.launches).toEqual([
      expect.objectContaining({
        target: "#12",
        outcome: "waits",
        detail: expect.stringContaining(
          "the host's validation capacity holds it",
        ),
      }),
    ]);
    expect(claudeRuns(w)).toHaveLength(1);

    const roomy = await tick(w, host(w, 0));
    const [launch] = roomy.repos[0]?.launches ?? [];
    expect(launch).toEqual(
      expect.objectContaining({ target: "#12", outcome: "launched" }),
    );
    const again = String(launch?.record);
    expect(readRecord(again, root)).toEqual(
      expect.objectContaining({
        relaunchOf: id,
        relaunchLockWait: true,
        workspace: expect.objectContaining({ path }),
      }),
    );
    await waitFor("the relaunch", () => claudeRuns(w).length === 2);
    const run = claudeRuns(w)[1];
    expect(run?.cwd).toBe(path);
    expect(run?.argv.at(-1)).toContain(
      `This pass continues the pickup ${id} of #12`,
    );
    await waitFor("the relaunch's exit", () => exitWritten(w, again));
  }, 120_000);
});
