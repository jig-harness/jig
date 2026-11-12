import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { cloneKey } from "../scripts/lib/state/clone-key.ts";
import { Defect } from "../../../shared/errors.ts";
import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import * as checkout from "../scripts/lib/base-drift.ts";
import * as stopped from "../scripts/lib/ledger-stop.ts";
import { worktreePathKey } from "../scripts/lib/state/actor.ts";
import * as processes from "../../../shared/process-table.ts";
import * as leases from "../scripts/lib/state/lease.ts";
import * as forge from "../scripts/lib/state/ledger-forge.ts";
import * as policy from "../scripts/lib/ci-policy.ts";
import * as proc from "../scripts/lib/proc.ts";
import * as timeline from "../scripts/lib/pr-timeline.ts";
import * as status from "../scripts/lib/status/evaluate.ts";
import { ciHoldDoctor } from "../scripts/lib/ci-hold-doctor.ts";
import { freshState } from "../scripts/lib/state/schema.ts";
import { cloneId } from "../scripts/lib/state/ledger-mirror.ts";
import {
  ledgerFromState,
  snapshotFrom,
  renderLedger,
} from "../scripts/lib/state/ledger.ts";
import { thisHost } from "../../../shared/liveness.ts";
import type { Lease } from "../scripts/lib/state/lease.ts";

const head = "a".repeat(40);
// The Git common directory is a throwaway fixture, so minting the clone
// identity never writes into the checkout running the suite.
const commonDir = realpathSync(
  mkdtempSync(join(tmpdir(), "ci-hold-doctor-git-")),
);
afterAll(() => rmSync(commonDir, { recursive: true, force: true }));
const stateDir = join("/tmp", cloneKey(commonDir));
const started = "2026-11-06T12:00:00.000Z";
const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});
function watch<T extends object, K extends keyof T>(object: T, key: K) {
  const spy = spyOn(object, key);
  restore.push(() => spy.mockRestore());
  return spy;
}

interface Options {
  foreign?: boolean;
  live?: boolean;
  parked?: boolean;
  operation?: boolean;
  operationReadFailure?: boolean;
  moved?: boolean;
  failure?: boolean;
  wrongClone?: boolean;
  releasedRecord?: boolean;
  unreleasedRecord?: boolean;
  orphanPass?: boolean;
  newerClaim?: boolean;
  gitFailure?: "--git-common-dir" | "HEAD" | "status";
  branchReason?: string;
  timelineFailure?: boolean;
  reviewState?: "UNSUPPORTED_CLI" | "INDETERMINATE" | "AWAITING_REVIEWER";
}

function arrange(options: Options = {}) {
  const state = freshState(123);
  state.ciHold = {
    phase: "held",
    eventId: "42",
    actor: "operator",
    addedAtHead: head,
    createdAt: started,
    checkRunWatermark: 1,
  };
  const lease = recordIdentity(options);
  recordLedger(state, lease, options);
  const calls = forgeReads(options);
  treeAndReviewReads(options);
  return { state, calls };
}

function recordIdentity(options: Options) {
  const lease: Lease = {
    ...thisHost(),
    holder: "session",
    pid: 12345,
    start: "Fri Nov 6 12:00:00 2026",
    platform: process.platform,
    actor: `wt-${worktreePathKey(process.cwd())}`,
    worktree: process.cwd(),
    startedAt: started,
    lastSeen: started,
    expiresAt: started,
    command: "review",
    generation: 1,
    sessionStarted: started,
  };
  if (options.foreign) {
    lease.host = "other-machine";
    lease.hostId = "other-machine";
  }
  watch(leases, "leaseRefsFor").mockReturnValue([
    { stateDir, pr: "123", actor: lease.actor },
  ]);
  watch(leases, "readLease").mockReturnValue(
    options.releasedRecord || options.unreleasedRecord ? null : lease,
  );
  watch(stopped, "readDriverRecord").mockReturnValue({
    worktree: lease.worktree,
    started,
    pid: lease.pid,
    host: lease.host,
    ...(options.unreleasedRecord || options.orphanPass
      ? {}
      : { released: true }),
  });
  watch(processes, "processTable").mockResolvedValue(
    options.live
      ? [
          {
            pid: lease.pid,
            ppid: 1,
            start: lease.start,
            stat: "S",
            args: "bun drive.ts",
            pgid: 1,
          },
        ]
      : [],
  );
  return lease;
}

function recordLedger(
  state: ReturnType<typeof freshState>,
  lease: Lease,
  options: Options,
) {
  watch(policy, "holdLabelPolicy").mockReturnValue("ci:hold");
  watch(forge, "resolveLogin").mockResolvedValue("operator");
  const ledger = ledgerFromState(state, {
    driver: {
      actor: lease.actor,
      clone: cloneId(stateDir),
      state: "running",
      heartbeat: started,
      started,
    },
    narrative: [],
    generation: 1,
    claims: [],
  });
  if (options.parked)
    ledger.parked = [
      { key: "question", kind: "thread", reason: "needs a person", round: 1 },
    ];
  const rendered = renderLedger(ledger);
  if (!("body" in rendered)) throw new Defect(rendered.error);
  const body = rendered.body;
  const snapshot = snapshotFrom(
    [
      {
        id: 1,
        body,
        login: "operator",
        association: "OWNER",
        updatedAt: started,
      },
    ],
    "operator",
  );
  if (options.newerClaim)
    snapshot.claims.push({
      id: 99,
      claim: {
        actor: "wt-successor",
        clone: "other-clone",
        generation: 2,
        at: new Date().toISOString(),
      },
    });
  watch(forge, "readLedgerSnapshot").mockResolvedValue(snapshot);
}

function forgeReads(options: Options) {
  const calls: string[][] = [];
  watch(proc, "ghCall").mockImplementation(async (args) => {
    calls.push(args);
    const out =
      args[0] === "pr"
        ? {
            state: "OPEN",
            headRefOid: head,
            headRefName: "feature",
            labels: [{ name: "ci:hold" }],
          }
        : { nameWithOwner: "example/project" };
    return {
      code: options.failure ? 1 : 0,
      stdout: JSON.stringify(out),
      stderr: "",
      timedOut: false,
      bufferExceeded: false,
      spawnFailed: false,
      stderrTail: "",
    };
  });
  watch(timeline, "readTimeline").mockResolvedValue({
    ok: true,
    value: [
      {
        id: 42,
        node_id: "42",
        event: "labeled",
        label: { name: "ci:hold" },
        actor: { login: "operator" },
        created_at: started,
      },
    ],
  });
  if (options.timelineFailure)
    watch(timeline, "readTimeline").mockResolvedValue({
      ok: false,
      failure: {
        code: "unreadable",
        reason: "PR #123 timeline: gh api exited 1: authentication required",
      },
    });
  return calls;
}

function treeAndReviewReads(options: Options) {
  watch(proc, "git").mockImplementation(async (args, opts) => {
    let stdout = "";
    if (args.includes("HEAD") && args.includes("rev-parse"))
      stdout = `${head}\n`;
    if (args.includes("--git-common-dir"))
      stdout = `${options.wrongClone && opts?.cwd ? "/tmp" : commonDir}\n`;
    if (args.includes("--abbrev-ref")) stdout = "feature\n";
    if (args.includes("--git-path")) stdout = "/nonexistent/operation-marker\n";
    const failed =
      options.gitFailure !== undefined && args.includes(options.gitFailure);
    return {
      code: failed ? 128 : 0,
      stdout,
      stderr: failed ? "fatal: fixture git access denied" : "",
      timedOut: false,
      bufferExceeded: false,
      spawnFailed: false,
      stderrTail: "",
    };
  });
  if (options.branchReason !== undefined)
    watch(checkout, "verifyCheckoutIsPrHead").mockResolvedValue({
      ok: false,
      why: options.branchReason,
    });
  watch(proc, "unconcludedGitOpMarker").mockResolvedValue({
    ok: true,
    marker: options.operation ? "MERGE_HEAD" : null,
  });
  if (options.operationReadFailure)
    watch(proc, "unconcludedGitOpMarker").mockResolvedValue({
      ok: false,
      reason: "git operation marker probe exited 1: access denied",
    });
  watch(status, "evaluate").mockImplementation(async (_ctx, report) => {
    Object.assign(report, {
      state: options.reviewState ?? (options.moved ? "HEAD_LAG" : "CONVERGED"),
      reason:
        options.reviewState === "UNSUPPORTED_CLI"
          ? "upgrade gh: headRefOid is unavailable"
          : "review evidence is not ready",
      apiHead: options.moved ? "b".repeat(40) : head,
    });
    return options.moved ? 4 : 3;
  });
}

describe("CI hold doctor evidence gathering", () => {
  it("passes installed sibling helper paths to the review evaluator", async () => {
    const { state } = arrange();
    const evaluate = watch(status, "evaluate").mockImplementation(
      async (ctx, report) => {
        for (const path of [
          ctx.driveStateScript,
          ctx.listThreadsScript,
          ctx.summaryScript,
        ])
          expect(existsSync(path)).toBe(true);
        expect(ctx.listThreadsScript).toBe(
          resolve(
            import.meta.dir,
            "../../resolve-review-comments/scripts/list-unresolved-threads.ts",
          ),
        );
        Object.assign(report, { state: "CONVERGED", apiHead: head });
        return 3;
      },
    );
    const result = await ciHoldDoctor(
      stateDir,
      "123",
      state,
      "empty",
      resolve(import.meta.dir, "../scripts"),
    );
    expect(evaluate).toHaveBeenCalled();
    expect(result.review).toBe("converged");
  });

  it("reconciles a running forge ledger with a stopped local identity and offers direct release", async () => {
    const { state, calls } = arrange();
    const result = await ciHoldDoctor(
      stateDir,
      "123",
      state,
      "empty",
      "/plugin/scripts",
    );
    expect(result.driver).toBe("dead");
    expect(result.review).toBe("converged");
    expect({ reason: result.reason, recovery: result.recovery }).toEqual(
      expect.objectContaining({
        recovery: expect.stringContaining(`cd ${process.cwd()}`),
      }),
    );
    expect(result.recovery).toContain(`release 123 --expect-head ${head}`);
    expect(
      calls.every(
        (args) =>
          (args[0] === "pr" && args[1] === "view") ||
          (args[0] === "repo" && args[1] === "view"),
      ),
    ).toBe(true);
  });
  it("preserves positively identified live drivers behind a live lock", async () => {
    const { state } = arrange({ live: true, orphanPass: true });
    const result = await ciHoldDoctor(
      stateDir,
      "123",
      state,
      "live",
      "/plugin/scripts",
    );
    expect(result.driver).toBe("alive");
    expect(result.recovery).toBeNull();
  });
  it("uses a released driver record after normal lease cleanup", async () => {
    const { state } = arrange({ releasedRecord: true });
    const result = await ciHoldDoctor(
      stateDir,
      "123",
      state,
      "empty",
      "/plugin/scripts",
    );
    expect(result.driver).toBe("dead");
    expect(result.recovery).toContain("release 123");
  });
  for (const [options, reason] of [
    [
      { operationReadFailure: true },
      "git operation marker probe exited 1: access denied",
    ],
    [
      { gitFailure: "--git-common-dir" },
      "git rev-parse --git-common-dir (driver worktree) exited 128: fatal: fixture git access denied",
    ],
    [
      { gitFailure: "HEAD" },
      "git rev-parse HEAD exited 128: fatal: fixture git access denied",
    ],
    [
      { gitFailure: "status" },
      "git status --porcelain --untracked-files=normal --ignore-submodules=none exited 128: fatal: fixture git access denied",
    ],
    [
      {
        branchReason:
          "checked out on 'other', not this PR's head branch 'feature'",
      },
      "checked out on 'other', not this PR's head branch 'feature'",
    ],
    [
      { timelineFailure: true },
      "timeline: gh api exited 1: authentication required",
    ],
    [
      { reviewState: "UNSUPPORTED_CLI" },
      "review evidence UNSUPPORTED_CLI: upgrade gh: headRefOid is unavailable",
    ],
    [
      { reviewState: "INDETERMINATE" },
      "review evidence INDETERMINATE: review evidence is not ready",
    ],
    [
      { reviewState: "AWAITING_REVIEWER" },
      "review evidence AWAITING_REVIEWER: review evidence is not ready",
    ],
  ] as const) {
    it(`names the evidence cause for ${JSON.stringify(options)}`, async () => {
      const { state } = arrange(options);
      const result = await ciHoldDoctor(
        stateDir,
        "123",
        state,
        "empty",
        "/plugin/scripts",
      );
      expect(result.recovery).toBeNull();
      expect(result.reason).toContain(reason);
      if (
        "reviewState" in options &&
        options.reviewState !== "AWAITING_REVIEWER"
      )
        expect(result.review).toBe("unknown");
    });
  }
  for (const options of [
    { foreign: true },
    { live: true },
    { parked: true },
    { operation: true },
    { moved: true },
    { failure: true },
    { wrongClone: true },
    { unreleasedRecord: true },
    { orphanPass: true },
    { newerClaim: true },
  ]) {
    it(`withholds direct release for ${JSON.stringify(options)}`, async () => {
      const { state } = arrange(options);
      const result = await ciHoldDoctor(
        stateDir,
        "123",
        state,
        "empty",
        "/plugin/scripts",
      );
      expect(result.recovery).toBeNull();
    });
  }
});
