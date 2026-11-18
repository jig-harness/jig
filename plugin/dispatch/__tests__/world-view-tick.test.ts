/**
 * dispatch: the world view (`lib/world-view.ts`). Its direct implementation
 * reads what the tick read before it: a tick over a world with a drive
 * running, a drive stopped, a merge and an assigned item makes the same
 * forge calls and the same tracker requests, no more and no fewer. A tick
 * over a view that replays those facts, reading nothing, plans the same
 * work; each fact carries its freshness class; a launch still reads the
 * forge at use, whatever the view said; and the observe phase writes
 * nothing of this host's launch records into a fact the view returned.
 * Each tick runs in a child with its own home (fixtures.ts,
 * world-view-child.ts).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { currentIso } from "../../shared/time.ts";
import type { TickReceipt } from "../receipts.ts";
import type { ForgeRead } from "../lib/tick-forge.ts";
import type { DrivenPr, LedgerClass } from "../lib/types.ts";
import { keepStewardRun, submitStewardRecords } from "../lib/steward.ts";
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { FRESHNESS_BOUND_MS, forgeFacts } from "../lib/world-view.ts";
import {
  assignedIssue,
  BASE_SHA,
  HEAD_SHA,
  ledgerComment,
  mergedPr,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import {
  account,
  claimed,
  driveRuns,
  earlierRecord,
  dispatchState,
  machineFile,
} from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";
import {
  type ChildResult,
  COVERED_CALLS,
  SECOND_TICK,
} from "./world-view-child.ts";

const CHILD = resolve(import.meta.dir, "world-view-child.ts");

const CONFIG = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  identity: factory-bot
  followup_command: /followup
`;

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** The running ledger of `pr`: its heartbeat now. */
function runningLedger(pr: number) {
  const running = stoppedLedger(pr, undefined);
  running.driver = {
    ...running.driver,
    state: "running",
    heartbeat: currentIso(),
  };
  return running;
}

/** PR #7's drive running with a fresh heartbeat, PR #8's stopped with no exit, PR #5 merged, issue #12 assigned. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(CONFIG);
  const running = runningLedger(7);
  w.setPrs("open", [openPr(7, "feature/7"), openPr(8, "feature/8")]);
  w.setComments(7, [ledgerComment(701, running)]);
  w.setComments(8, [ledgerComment(801, stoppedLedger(8, undefined))]);
  w.setPrs("merged", [mergedPr(5, "feature/5", "2026-10-31T00:00:00Z")]);
  w.setComments(5, []);
  w.setIssues([assignedIssue(12, "factory-bot", [])]);
  w.setAssigner(12, "maintainer", "WRITE");
  machineFile(w, [account(w, "a", "a@example.com")], {}, [
    "rearm",
    "pickup",
    "followup",
  ]);
  return w;
}

/** Every `gh` call the fake answered, a GraphQL query by its operation's name. */
function ghCalls(w: World): string[] {
  return calls(w).map((line) => {
    const op = /(?:query|mutation)\s+(\w+)/.exec(line)?.[1];
    return op === undefined ? line : `graphql ${op}`;
  });
}

/** Every line of the fake `gh`'s call log, as it wrote them. */
function calls(w: World): string[] {
  const path = join(w.dir, "gh-calls.log");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
}

/** Run the child's `mode` in the world's home; what it printed. */
async function child(w: World, mode: string): Promise<ChildResult> {
  const r = await w.dispatch([mode], CHILD);
  expectSpawnExit(r, 0);
  const last = r.stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(last) as ChildResult;
}

/** What a receipt's first repository planned: each action's stage, target and reason. */
const planned = (receipt: TickReceipt | undefined) =>
  (receipt?.repos[0]?.actions ?? []).map((a) => [a.stage, a.target, a.reason]);

describe("the world view's direct implementation", () => {
  it("makes the calls a tick made before it, no new read and no write", async () => {
    const w = fixture();
    const r = await w.dispatch([
      "--followup-since",
      "2026-10-30T00:00:00Z",
      "--json",
    ]);
    expectSpawnExit(r, 0);
    const receipt = JSON.parse(r.stdout) as TickReceipt;
    // The tick still plans from what it read: the pickup, the re-arm and the follow-up.
    expect(
      (receipt.repos[0]?.actions ?? []).map((a) => `${a.stage} ${a.target}`),
    ).toEqual(["pickup #12", "rearm PR #8", "followup PR #5"]);
    expect(ghCalls(w).toSorted()).toEqual([
      "api --paginate --slurp repos/example-org/example-repo/issues/5/comments?per_page=100",
      "api rate_limit",
      "api user --jq .login",
      "graphql DispatchRepository",
      "pr list --repo example-org/example-repo --state merged --search merged:>=2026-10-30 --limit 1000 --json number,url,title,headRefName,createdAt,mergedAt,updatedAt",
    ]);
    expect(w.trackerOps().toSorted()).toEqual([
      "TrackerAssignedBy",
      "TrackerCollaborator",
      "TrackerComments",
      "TrackerDispatchQueue",
      "TrackerFacetEvidence",
      "TrackerIssue",
    ]);
  });
});

describe("a tick over a world view its caller supplies", () => {
  it("plans the same work from replayed facts as from the direct reads, reading none of them", async () => {
    const w = fixture();
    const { receipts } = await child(w, "replay");
    const [direct, replayed] = receipts;
    expect(
      planned(direct).map(([stage, target]) => `${stage} ${target}`),
    ).toEqual(["pickup #12", "rearm PR #8", "followup PR #5"]);
    expect(planned(replayed)).toEqual(planned(direct));
    expect(replayed?.repos[0]?.refused).toBeNull();
    // The replayed tick asked the forge for nothing the view covers, and the tracker for nothing.
    const second = calls(w).slice(calls(w).indexOf(SECOND_TICK) + 1);
    expect(second.length).toBeGreaterThan(0);
    for (const match of COVERED_CALLS)
      expect(second.filter((c) => c.includes(match))).toEqual([]);
    expect(w.trackerOps().toSorted()).toEqual([
      "TrackerAssignedBy",
      "TrackerCollaborator",
      "TrackerComments",
      "TrackerDispatchQueue",
      "TrackerFacetEvidence",
      "TrackerIssue",
    ]);
  }, 90_000);

  it("gives every fact the direct view returns its class: active for a running drive, background otherwise", async () => {
    const w = fixture();
    const { classes } = await child(w, "replay");
    expect(classes).toEqual([
      { method: "target", freshness: "background" },
      { method: "configuration", freshness: "background" },
      { method: "tracker", freshness: "background" },
      {
        method: "forge",
        freshness: "active",
        pullRequests: { "5": "background", "7": "active", "8": "background" },
      },
    ]);
  }, 90_000);

  it("launches on what the forge says at use, not on what the view served", async () => {
    const w = fixture();
    withOrigin(w);
    const ws = join(w.root, "ws-8");
    mkdirSync(ws, { recursive: true });
    w.setWorkspaces([{ branch: "feature/8", linkedPR: 8, path: ws }]);
    // Between the plan's read and the launch, a driver starts on PR #8.
    writeFileSync(
      join(w.dir, "gate-comments-8.json"),
      JSON.stringify([ledgerComment(801, runningLedger(8))]),
    );
    const { receipts } = await child(w, "gate");
    const [, applied] = receipts;
    expect(
      planned(applied).some(([s, t]) => s === "rearm" && t === "PR #8"),
    ).toBe(true);
    const launch = (applied?.repos[0]?.launches ?? []).find(
      (l) => l.target === "PR #8",
    );
    expect(launch?.outcome).not.toBe("launched");
    expect(String(launch?.detail)).toContain("changed since the plan read it");
    expect(driveRuns(w)).toEqual([]);
  }, 90_000);
});

describe("the machine view apart from the world view", () => {
  it("settles a drive by this host's launch record without writing into the forge's or the tracker's facts", async () => {
    const w = world();
    current = w;
    w.setConfig(CONFIG);
    const change = `head ${HEAD_SHA}, base ${BASE_SHA}`;
    w.setPrs("open", [openPr(7, "feature/7", { mergeable: "CONFLICTING" })]);
    const stop = stoppedLedger(7, 9, { verifiedSha: HEAD_SHA });
    stop.driver = { ...stop.driver, heartbeat: currentIso() };
    w.setComments(7, [ledgerComment(701, stop)]);
    machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
    // This host already re-drove PR #7 for the change its ledger shows, and that drive stopped 9 again.
    const id = "20261030T200000Z-aaaaaaaa";
    earlierRecord(w, {
      id,
      account: "a",
      redrive: {
        cause: "stopped on a conflict with its base, and still conflicting",
        change,
        conflictStop: true,
      },
    });
    claimed(
      w,
      id,
      {
        hostId: "",
        host: "elsewhere",
        bootId: "",
        pid: 1,
        start: "",
        claimedAt: "2026-10-30T20:00:00.000Z",
      },
      9,
    );
    const { receipts, forgeDrive } = await child(w, "frozen");
    const [receipt] = receipts;
    expect(receipt?.repos[0]?.defect).toBeUndefined();
    // The forge's fact is what the forge said, before the tick and after it.
    expect(forgeDrive).toEqual({ returned: "stale", after: "stale" });
    // The plan read the drive as this host's record settles it: a person's.
    const [notify] = planned(receipt);
    expect(notify?.slice(0, 2)).toEqual(["notify", "PR #7"]);
    expect(String(notify?.[2])).toContain(
      `launch record ${id} already re-drove it`,
    );
  }, 90_000);
});

describe("planning's own tracker copy", () => {
  it("orders the pickups for the steward without touching the fact the view returned", async () => {
    const w = world();
    current = w;
    w.setConfig(CONFIG);
    w.setPrs("open", []);
    w.setPrs("merged", []);
    w.setIssues([
      assignedIssue(12, "factory-bot", []),
      assignedIssue(13, "factory-bot", []),
    ]);
    w.setAssigner(12, "maintainer", "WRITE");
    w.setAssigner(13, "maintainer", "WRITE");
    machineFile(
      w,
      [account(w, "a", "a@example.com")],
      { steward: { enabled: true, every: "20m" } },
      ["pickup", "steward"],
    );
    const issue = (key: string) =>
      ({
        identifier: key,
        title: "Task",
        url: null,
        type: "task",
        priority: 2,
        size: "small",
        state: { id: "todo", name: "Todo", type: "unstarted" },
        createdAt: "2026-01-01",
        assignee: { id: "a", name: "factory-bot" },
        labels: [],
        hasOpenChildren: false,
        isEpic: false,
        truncated: [],
      }) as unknown as PoolIssue;
    keepStewardRun(
      "ordered",
      {
        version: 1,
        repo: SLUG,
        backlog: [],
        drives: [],
        needs: [],
        queue: [issue("#12"), issue("#13")],
        passes: [],
        failures: [],
        load: null,
      },
      Date.now(),
      dispatchState(w),
    );
    expect(
      submitStewardRecords(
        "ordered",
        [{ kind: "order", targets: ["#12", "#13"], reason: "keep the tie" }],
        dispatchState(w),
      ).ok,
    ).toBe(true);
    const { receipts, pickups } = await child(w, "frozen");
    // Planning took its own copy to order: the frozen fact still reads as the view returned it.
    expect(receipts[0]?.repos[0]?.defect).toBeUndefined();
    expect(pickups?.returned.length).toBe(2);
    expect(pickups?.after).toEqual(pickups?.returned);
  }, 90_000);
});

describe("each forge fact's freshness class", () => {
  const drive = (number: number, cls: LedgerClass) =>
    ({ number, class: cls }) as unknown as DrivenPr;
  const read = (drives: DrivenPr[], merged: number[] = []): ForgeRead => ({
    ok: true,
    open: drives.map((d) => ({
      ...openPr(d.number, `feature/${d.number}`),
      labels: [],
    })),
    read: new Set(drives.map((d) => d.number)),
    scoped: false,
    inScope: new Set(),
    disputed: new Set(),
    created: new Map(),
    drives,
    merged: merged.map((n) => ({
      number: n,
      url: "",
      title: "",
      head: `feature/${n}`,
      mergedAt: "2026-10-31T00:00:00Z",
      markers: [],
    })),
    login: "drive-bot",
  });

  it("is active for an open pull request whose drive runs or is armed, background for every other", () => {
    const facts = forgeFacts(
      read(
        [
          drive(1, "driven"),
          drive(2, "silent"),
          drive(3, "refused"),
          drive(4, "re-armable"),
          drive(5, "parked"),
          drive(6, "unarmed"),
        ],
        [9],
      ),
    );
    expect(Object.fromEntries(facts.pullRequests)).toEqual({
      1: "active",
      2: "active",
      3: "active",
      4: "background",
      5: "background",
      6: "background",
      9: "background",
    });
    expect(facts.freshness).toBe("active");
  });

  it("bounds an active fact at 10 minutes and every other at 75", () => {
    expect(FRESHNESS_BOUND_MS).toEqual({
      active: 10 * 60_000,
      background: 75 * 60_000,
    });
  });

  it("makes a read with no active pull request background as a whole", () => {
    const facts = forgeFacts(read([drive(4, "stale")], [9]));
    expect(facts.freshness).toBe("background");
    expect([...facts.pullRequests.values()]).toEqual([
      "background",
      "background",
    ]);
  });
});
