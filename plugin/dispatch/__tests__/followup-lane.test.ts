/**
 * The follow-ups' own lane: a follow-up opens its workspace from
 * `followup_opens_per_tick`, never from the drive launches' `opens_per_tick`
 * or the notices workspace's reserved open, no more than
 * `followup_concurrency` run at once, and a waiting follow-up says what it
 * waits on.
 */
import { afterEach, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { joinedWorkspace, laneCapWait } from "../lib/actions/followup-lane.ts";
import {
  type ApplyState,
  openWithinBudget,
  replay,
  admitAccount,
} from "../lib/actions/launch.ts";
import {
  applyFollowups,
  type FollowupContext,
} from "../lib/actions/followup.ts";
import { currentMs } from "../../shared/time.ts";
import type { ReadRecord } from "../lib/launches.ts";
import type { SessionsReport } from "../lib/runtime/port.ts";
import type { LineSnapshot } from "../lib/dashboard-contract.ts";
import { newPreflight } from "../lib/preflight.ts";
import type { MachineAccount, MachineConfig } from "../lib/machine-config.ts";
import { existingStateDb } from "../lib/state.ts";
import type {
  Action,
  LaunchOutcome,
  RepoReport,
  RepoTarget,
} from "../lib/types.ts";
import type { LaunchRecord } from "../lib/launches.ts";
import type { TickReceipt } from "../receipts.ts";
import {
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
  dispatchState,
  machineFile,
  waitFor,
} from "./launch-fixtures.ts";
import { claudeRuns, publishedBranch, withOrigin } from "./pickup-fixtures.ts";

let current: World | null = null;
afterEach(() => {
  if (current) writeFileSync(join(current.dir, "claude-exit"), "");
  current?.close();
  current = null;
});

const repo = { slug: SLUG, path: "/tmp/repo" } as RepoTarget;
const dispatched = { name: "test", mark: "test" };
const pull = { pr: 7, head: "feature/7", dispatched };
const notice = { notices: "jig-dispatch-notices", dispatched };

function state(): ApplyState {
  return {
    machine: {
      opensPerTick: 4,
      followupOpensPerTick: 2,
      followupConcurrency: 2,
      workspaceTimeoutMs: 1000,
      runtimeTimeoutMs: 1000,
      repositories: [{ stages: ["notify"] }],
    } as MachineConfig,
    runtime: {
      openWorkspace: async () => ({
        ok: true,
        detail: "opened",
        workspace: { id: "1", path: "/tmp/ws" },
      }),
    },
  } as unknown as ApplyState;
}

it("opens the notices workspace and every launch open after the follow-ups' lane spent its whole budget", async () => {
  const s = state();
  for (let i = 0; i < 2; i++)
    expect(await openWithinBudget(s, repo, pull, true)).toHaveProperty(
      "workspace",
    );
  expect(await openWithinBudget(s, repo, pull, true)).toEqual({
    waits: expect.stringContaining("followup_opens_per_tick"),
    waitsOn: "lane-budget",
  });
  // The launches keep their three opens beside the reserved one.
  for (let i = 0; i < 3; i++)
    expect(await openWithinBudget(s, repo, pull)).toHaveProperty("workspace");
  expect(await openWithinBudget(s, repo, notice)).toHaveProperty("workspace");
  expect(s.opened).toBe(4);
  expect(s.followupOpened).toBe(2);
});

const listed: SessionsReport = { ok: true, source: "orca", workspaces: [] };

/** A follow-up's launch record in `state`, as the lane counts it. */
function followupRecord(
  id: string,
  kind: "pending" | "alive",
  noReplay: string | null = null,
): ReadRecord {
  return {
    record: {
      id,
      action: "followup",
      repo: SLUG,
      pr: 50,
      item: null,
      workspace: { id: "w", path: "/tmp/ws" },
      attempts: [],
      noReplay,
    },
    state: kind === "pending" ? { kind } : { kind, process: {} as never },
    result: null,
  } as unknown as ReadRecord;
}

it("leaves a follow-up stuck pending out of the lane's cap, and counts one that runs", () => {
  const s = state();
  s.machine = { ...s.machine, followupConcurrency: 1, unclaimedAfterMs: 1 };
  s.records = [followupRecord("stuck", "pending", "its marker is gone")];
  expect(laneCapWait(s, listed, SLUG)).toBeNull();
  s.records.push(followupRecord("runs", "alive"));
  expect(laneCapWait(s, listed, SLUG)).toContain("followup_concurrency");
});

it("counts a stuck follow-up of another repository, whose absence from this listing proves nothing", () => {
  const s = state();
  s.machine = { ...s.machine, followupConcurrency: 1, unclaimedAfterMs: 1 };
  s.records = [followupRecord("stuck", "pending", "its marker is gone")];
  expect(laneCapWait(s, listed, "owner/other")).toContain(
    "followup_concurrency",
  );
});

it("leaves a stuck follow-up of another repository out of the cap once that repository's own listing shows its target free", () => {
  const s = state();
  s.machine = { ...s.machine, followupConcurrency: 1, unclaimedAfterMs: 1 };
  s.records = [followupRecord("stuck", "pending", "its marker is gone")];
  s.sessionsOf = new Map([[SLUG, listed]]);
  expect(laneCapWait(s, listed, "owner/other")).toBeNull();
  s.sessionsOf = new Map([
    [SLUG, { ok: false, source: "orca", reason: "timed out" }],
  ]);
  expect(laneCapWait(s, listed, "owner/other")).toContain(
    "followup_concurrency",
  );
});

it("counts a stuck follow-up whose target has a session running, or whose sessions cannot be read", () => {
  const s = state();
  s.machine = { ...s.machine, followupConcurrency: 1, unclaimedAfterMs: 1 };
  s.records = [followupRecord("stuck", "pending", "its marker is gone")];
  // A wrapper may run its stage on the target without having claimed the record.
  const running = {
    id: "w50",
    path: "/tmp/ws50",
    branch: "merged/50",
    items: [],
    prs: [50],
    agents: [{ state: "working" }],
    unverifiableTerminals: 0,
    comment: "",
    unread: null,
    name: "",
  } as unknown as Extract<SessionsReport, { ok: true }>["workspaces"][number];
  expect(
    laneCapWait(s, { ok: true, source: "orca", workspaces: [running] }, SLUG),
  ).toContain("followup_concurrency");
  expect(
    laneCapWait(s, { ok: false, source: "orca", reason: "timed out" }, SLUG),
  ).toContain("followup_concurrency");
});

it("waits, with the cause, rather than read a failed session listing as no workspace joined", async () => {
  expect(
    await joinedWorkspace(async () => {
      throw new Error("orca is not running");
    }, 7),
  ).toEqual({ failed: expect.stringContaining("orca is not running") });
  expect(
    await joinedWorkspace(
      async () => ({
        ok: false,
        source: "orca",
        reason: "the listing timed out",
      }),
      7,
    ),
  ).toEqual({ failed: "the listing timed out" });
  const workspace = {
    id: "w7",
    path: "/tmp/ws7",
    prs: [7],
  } as unknown as Extract<SessionsReport, { ok: true }>["workspaces"][number];
  expect(
    await joinedWorkspace(
      async () => ({ ok: true, source: "orca", workspaces: [workspace] }),
      7,
    ),
  ).toMatchObject({ joined: { id: "w7", path: "/tmp/ws7" } });
});

function fixture(): World {
  const w = world();
  current = w;
  withOrigin(w);
  w.setConfig(
    `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  followup_command: /followup\n`,
  );
  return w;
}

/** A drive stopped on a usage limit, which wants a re-arm; a drive parked on a decision, which wants a notice; and `merges` merged pull requests no follow-up claimed. */
function queued(
  w: World,
  slots: number,
  merges: number,
  lane: Record<string, number> = {},
): void {
  machineFile(
    w,
    [{ ...account(w, "a", "a@example.com"), max: slots }],
    // A short workspace limit, so the deadline the tick runs under is a test's.
    { opens_per_tick: 2, workspace_timeout: "20s", ...lane },
    ["rearm", "followup", "notify"],
    { followup_since: "2026-10-30T00:00:00Z" },
  );
  publishedBranch(w, "feature/1");
  w.setPrs("open", [openPr(1, "feature/1"), openPr(99, "feature/99")]);
  w.setComments(1, [ledgerComment(1000, stoppedLedger(1, 16))]);
  w.setComments(99, [
    ledgerComment(
      99000,
      stoppedLedger(99, 8, {
        parked: [
          {
            key: "F1",
            kind: "finding",
            reason: "Choose the retry limit",
            round: 1,
            at: new Date().toISOString(),
            class: "design-choice",
            record: "Choose the retry limit",
          },
        ],
      }),
    ),
  ]);
  w.setPrs(
    "merged",
    Array.from({ length: merges }, (_, i) =>
      mergedPr(i + 10, `merged/${i + 10}`, "2026-10-31T12:00:00Z"),
    ),
  );
  for (let n = 10; n < 10 + merges; n++) w.setComments(n, []);
}

/** The deadline the installed launcher would enforce, in seconds. */
const DEADLINE_SEC = 600;

async function tick(w: World): Promise<TickReceipt> {
  w.env.JIG_LAUNCHER_DEADLINE_SEC = String(DEADLINE_SEC);
  const result = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(result, 0);
  return JSON.parse(result.stdout) as TickReceipt;
}

const launches = (r: TickReceipt): LaunchOutcome[] =>
  r.repos.flatMap((repo) => repo.launches);
const followups = (r: TickReceipt) =>
  launches(r).filter((l) => l.action === "followup");

function line(w: World): LineSnapshot {
  const row = existingStateDb(dispatchState(w))
    ?.query("SELECT line FROM tick_line WHERE id = 1")
    .get() as { line: string };
  return JSON.parse(row.line) as LineSnapshot;
}

it("starts a drive's launch and the follow-ups up to the lane's budget in one tick, inside its deadline, and names the lane's budget for the rest", async () => {
  const w = fixture();
  // A cap above the budget, so the budget is what holds the rest back.
  queued(w, 8, 5, { followup_concurrency: 5 });
  const receipt = await tick(w);
  expect(receipt.completed).toBe(true);
  expect(
    Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt),
  ).toBeLessThan(DEADLINE_SEC * 1000);
  const started = launches(receipt).filter((l) => l.outcome === "launched");
  expect(started.filter((l) => l.action === "rearm")).toHaveLength(1);
  expect(started.filter((l) => l.action === "followup")).toHaveLength(2);
  const waiting = followups(receipt).filter((l) => l.outcome === "waits");
  expect(waiting).toHaveLength(3);
  for (const l of waiting) {
    expect(l.waitsOn).toBe("lane-budget");
    expect(l.detail).toContain("followup_opens_per_tick");
    expect(
      line(w).queue.find((q) => q.target === l.target)?.launch?.waitsOn,
    ).toBe("lane-budget");
  }
  // The notices workspace kept its open beside both allowances.
  expect(receipt.repos[0]?.notifications.length ?? 0).toBeGreaterThan(0);
  expect(
    receipt.repos[0]?.notifications.every((n) => n.outcome === "sent"),
  ).toBe(true);
  const creates = readFileSync(join(w.dir, "orca-calls.log"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((s) => JSON.parse(s) as string[])
    .filter((c) => c[0] === "worktree" && c[1] === "create");
  expect(creates).toHaveLength(1 + 2 + 1);
}, 60_000);

it("names the lane's cap for a follow-up the host already runs enough of", async () => {
  const w = fixture();
  queued(w, 8, 4);
  expect(
    followups(await tick(w)).filter((l) => l.outcome === "launched"),
  ).toHaveLength(2);
  await waitFor("both passes", () => claudeRuns(w).length === 2);
  // Both passes still run, so the next tick starts none.
  const second = await tick(w);
  const waiting = followups(second).filter((l) => l.outcome === "waits");
  expect(waiting).toHaveLength(2);
  for (const l of waiting) {
    expect(l.waitsOn).toBe("lane-cap");
    expect(l.detail).toContain("followup_concurrency");
  }
}, 60_000);

it("names the accounts for a follow-up no admitted account has a free slot for", async () => {
  const w = fixture();
  // One slot, which the drive's re-arm or the first follow-up takes.
  queued(w, 1, 3);
  const receipt = await tick(w);
  expect(
    launches(receipt).filter((l) => l.outcome === "launched"),
  ).toHaveLength(1);
  const accounts = followups(receipt).filter((l) => l.waitsOn === "accounts");
  expect(accounts.length).toBeGreaterThan(0);
  for (const l of accounts) expect(l.outcome).toBe("waits");
}, 60_000);

it("names an admission refusal in the receipt and dashboard queue", async () => {
  const w = fixture();
  queued(w, 8, 1);
  const a = account(w, "a", "other@example.com");
  machineFile(
    w,
    [{ ...a, identity: "expected@example.com" }],
    {},
    ["followup"],
    {
      followup_since: "2026-10-30T00:00:00Z",
    },
  );
  const [held] = followups(await tick(w));
  expect(held?.outcome).toBe("refused");
  expect(held?.detail).toContain("identity check:");
  expect(held?.waitsOn).toBe("admission");
  expect(
    line(w).queue.find((q) => q.target === held?.target)?.launch?.waitsOn,
  ).toBe("admission");
}, 60_000);

it("carries a deadline wait from the receipt into the dashboard queue", async () => {
  const w = fixture();
  queued(w, 8, 1);
  w.env.JIG_LAUNCHER_DEADLINE_SEC = "1";
  const result = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(result, 0);
  const [held] = followups(JSON.parse(result.stdout) as TickReceipt);
  expect(held).toMatchObject({ outcome: "waits", waitsOn: "tick-deadline" });
  expect(
    line(w).queue.find((q) => q.target === held?.target)?.launch?.waitsOn,
  ).toBe("tick-deadline");
}, 60_000);

it("names the tick deadline before a follow-up, workspace open, admission probe or replay", async () => {
  const s = state();
  s.root = dispatchState(fixture());
  s.startedAt = currentMs() - 24 * 3_600_000;
  s.records = [];
  s.table = [];
  const action = { stage: "followup", target: "PR #7" } as Action;
  const report = { actions: [action], launches: [] } as unknown as RepoReport;
  await applyFollowups(s, repo, report, {} as FollowupContext);
  expect(report.launches[0]).toMatchObject({
    outcome: "waits",
    waitsOn: "tick-deadline",
  });
  expect(await openWithinBudget(s, repo, pull, true)).toMatchObject({
    waitsOn: "tick-deadline",
  });
  expect(
    await replay(
      s,
      { id: "pending", account: "a" } as LaunchRecord,
      action,
      null,
    ),
  ).toMatchObject({ waitsOn: "tick-deadline" });
  s.preflight = newPreflight({ preflight: ["tracker"] });
  expect(await admitAccount(s, repo.slug, action)).toMatchObject({
    outcome: { waitsOn: "tick-deadline" },
  });
});

it("names the deadline when a later wave of admission probes cannot start", async () => {
  const s = state();
  s.root = dispatchState(fixture());
  s.startedAt = currentMs();
  s.records = [];
  s.codexOptIn = { on: false, why: "not enabled" };
  const accounts = Array.from(
    { length: 6 },
    (_, n): MachineAccount => ({
      name: `a${n}`,
      vendor: "claude",
      configDir: `/tmp/a${n}`,
      identity: `a${n}`,
      maxPerAccount: 1,
    }),
  );
  s.table = accounts.map((account) => ({
    account,
    held: 0,
    wall: null,
    wallUnrecorded: false,
  }));
  s.passDeadlineSec = 3600;
  let asked = 0;
  s.preflight = newPreflight({ preflight: ["tracker"] }, async () => {
    if (++asked === 4) s.startedAt = currentMs() - 24 * 3_600_000;
    return { ok: false, kind: "unreachable", reason: "tracker unavailable" };
  });
  s.preflight.targets.set(SLUG, {
    slug: SLUG,
    path: repo.path,
    tracker: "github",
    values: {},
    report: {} as RepoReport,
  });
  const result = await admitAccount(s, SLUG, {
    stage: "followup",
    target: "PR #7",
  } as Action);
  expect(asked).toBe(4);
  expect(result).toMatchObject({
    outcome: {
      outcome: "waits",
      waitsOn: "tick-deadline",
      detail: expect.stringContaining("tracker preflight"),
    },
  });
});
