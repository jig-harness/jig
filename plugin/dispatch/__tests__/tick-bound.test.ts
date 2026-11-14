/**
 * dispatch: one bound for a tick its launcher bounds. Every read of the
 * observe phase keeps to it: the tracker's assigner and claimed-item reads,
 * the runtime's sessions and the forge's listings are given its signal where
 * their transport takes one and held to it either way, a read it ended
 * before it began is not started and goes on the report as a failed read,
 * and the tick still writes its receipt and lets its locks go. A tick no
 * launcher bounds has no bound, and reads as it always did.
 */
import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import type {
  FacetReadOptions,
  PoolIssue,
  Tracker,
} from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { failed, ok } from "../../shared/outcome.ts";
import { pool } from "../lib/pool.ts";
import { orcaRuntime } from "../lib/runtime/orca.ts";
import type {
  JoinTargets,
  SessionRuntime,
  SessionsReport,
} from "../lib/runtime/port.ts";
import { boundAt, type TickBound } from "../lib/sources/bounded.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import { facetBound } from "../lib/sources/tracker-facets.ts";
import { tickComments } from "../lib/tick-comments.ts";
import {
  deadlineOf,
  emptyReport,
  type TickContext,
  tickBound,
} from "../lib/tick-context.ts";
import { type ForgeReads, readForge } from "../lib/tick-forge.ts";
import { openRepo, readSessions } from "../lib/tick-observe.ts";
import { tickReads } from "../lib/tick-reads.ts";
import type { DispatchSection, RepoTarget } from "../lib/types.ts";
import type { TickReceipt } from "../receipts.ts";
import { assignedIssue, SLUG, world } from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";

const PASSED = "the tick's deadline passed before";

/** A read the other side never answers. */
const unanswered = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** A bound that ended before the read began. */
const spent = (): TickBound => ({
  deadline: Date.now() - 1,
  signal: AbortSignal.abort(new Error("the tick's deadline passed")),
});

/** A bound that ends `ms` from now. */
const endsIn = (ms: number): TickBound => boundAt(Date.now() + ms) as TickBound;

const section = {
  identity: "factory",
  states: ["todo"],
} as unknown as DispatchSection;

function item(key: string): PoolIssue {
  return {
    identifier: key,
    title: `title of ${key}`,
    url: null,
    createdAt: "2026-11-01T00:00:00Z",
    state: { id: "s", name: "Todo", type: "unstarted" },
    assignee: { id: "u", name: "factory" },
    labels: [],
    isEpic: false,
    hasOpenChildren: false,
    truncated: [],
    type: "bug",
    priority: 2,
    size: "small",
  };
}

interface Fake {
  tracker: Tracker;
  /** Each assigner read's key and the signal it was given. */
  assigners: Array<{ key: string; signal: AbortSignal | undefined }>;
  /** The options of each claimed-item read (the working states). */
  claimed: Array<FacetReadOptions | undefined>;
}

/** A tracker with no native queue whose assigned items are `issues`; `assigner` answers who assigned each. */
function fakeTracker(
  issues: PoolIssue[],
  assigner: () => Promise<{ id: string; name: string; trusted: boolean }>,
): Fake {
  const assigners: Fake["assigners"] = [];
  const claimed: Fake["claimed"] = [];
  const tracker = {
    adapter: "github",
    team: "example-org/example-repo",
    stateName: (s: string) => s,
    async facetStores() {
      return { facets: [], discovery: { status: "none", reason: "not asked" } };
    },
    async assignedIssues(
      _: string,
      states: readonly string[],
      o?: FacetReadOptions,
    ) {
      if (states.includes("in_progress")) {
        claimed.push(o);
        return [];
      }
      return issues;
    },
    assignedBy(key: string, _assignee?: string, signal?: AbortSignal) {
      assigners.push({ key, signal });
      return assigner();
    },
  } as unknown as Tracker;
  return { tracker, assigners, claimed };
}

const trusted = async () => ({ id: "p", name: "maintainer", trusted: true });

describe("the tracker's reads under the tick's bound", () => {
  it("starts no assigner or claimed-item read once the bound has ended, and unplaces each item with why", async () => {
    const fake = fakeTracker([item("#1"), item("#2")], trusted);
    const reading = await readPickups(() => fake.tracker, section, {
      bound: () => facetBound(undefined),
      tick: spent(),
    });
    expect(fake.assigners).toEqual([]);
    expect(fake.claimed).toEqual([]);
    expect(reading.wanted).toEqual([]);
    expect(reading.claimed).toBeNull();
    const reasons = reading.unplaced.map((u) => [u.target, u.reason]);
    expect(reasons).toContainEqual([
      "#1",
      `assigned to factory in Todo, but ${PASSED} who assigned it was read`,
    ]);
    expect(reasons).toContainEqual([
      "#2",
      `assigned to factory in Todo, but ${PASSED} who assigned it was read`,
    ]);
    expect(
      reading.unplaced.some((u) =>
        u.reason.endsWith(`${PASSED} they were read`),
      ),
    ).toBe(true);
  });

  it("gives an assigner read the tick's signal and stops it in flight at the deadline", async () => {
    const fake = fakeTracker([item("#1"), item("#2")], () => unanswered());
    const tick = endsIn(50);
    const reading = await readPickups(() => fake.tracker, section, {
      bound: () => facetBound(undefined),
      tick,
    });
    // The first read was asked with the tick's signal and stopped; the second never started.
    expect(fake.assigners).toEqual([{ key: "#1", signal: tick.signal }]);
    const reasons = Object.fromEntries(
      reading.unplaced.map((u) => [u.target, u.reason]),
    );
    expect(reasons["#1"]).toBe(
      "who assigned it cannot be read: stopped at the tick's deadline",
    );
    expect(reasons["#2"]).toContain(`${PASSED} who assigned it was read`);
  });

  it("reads every assigner and the claimed items with no signal when the tick has no bound", async () => {
    const fake = fakeTracker([item("#1"), item("#2")], trusted);
    const reading = await readPickups(() => fake.tracker, section, {
      bound: () => facetBound(undefined),
    });
    expect(fake.assigners).toEqual([
      { key: "#1", signal: undefined },
      { key: "#2", signal: undefined },
    ]);
    expect(fake.claimed).toEqual([undefined]);
    expect(reading.wanted.map((w) => w.key)).toEqual(["#1", "#2"]);
    expect(reading.claimed).toEqual([]);
  });
});

const REPO: RepoTarget = {
  path: "/nowhere/example-repo",
  slug: SLUG,
  defaultBranch: "main",
};
const JOIN: JoinTargets = { keys: null, branchPattern: "", pullRequests: [] };

/** A runtime whose sessions read waits for `answer`, keeping the signal each read was given. */
function fakeRuntime(answer: () => Promise<SessionsReport>): {
  runtime: SessionRuntime;
  signals: Array<AbortSignal | undefined>;
} {
  const signals: Array<AbortSignal | undefined> = [];
  const runtime = {
    name: "fake",
    sessions: (_repo: RepoTarget, _join: JoinTargets, signal?: AbortSignal) => {
      signals.push(signal);
      return answer();
    },
  } as unknown as SessionRuntime;
  return { runtime, signals };
}

describe("the runtime's read under the tick's bound", () => {
  it("is not started once the bound has ended, and is a failed read", async () => {
    const { runtime, signals } = fakeRuntime(async () => ({
      ok: true,
      source: "fake",
      workspaces: [],
    }));
    const read = await readSessions(runtime, REPO, JOIN, undefined, spent());
    expect(signals).toEqual([]);
    expect(read).toEqual({
      ok: false,
      source: "fake",
      reason: `${PASSED} the runtime was read`,
    });
  });

  it("is given the tick's signal and stopped in flight at the deadline", async () => {
    const { runtime, signals } = fakeRuntime(() => unanswered());
    const tick = endsIn(50);
    const read = await readSessions(runtime, REPO, JOIN, undefined, tick);
    expect(signals).toEqual([tick.signal]);
    expect(read).toEqual({
      ok: false,
      source: "fake",
      reason: "the runtime could not be read: stopped at the tick's deadline",
    });
  });

  it("reads as before when the tick has no bound", async () => {
    const answer: SessionsReport = { ok: true, source: "fake", workspaces: [] };
    const { runtime, signals } = fakeRuntime(async () => answer);
    expect(await readSessions(runtime, REPO, JOIN)).toBe(answer);
    expect(signals).toEqual([undefined]);
  });

  it("runs no Orca listing once the read's signal has aborted", async () => {
    const reader = orcaRuntime().sessionsOnce?.();
    const read = await reader?.(REPO, JOIN, spent().signal);
    expect(read).toEqual({
      ok: false,
      source: "orca worktree ps",
      reason: "the read was stopped before orca repo list ran",
    });
  });
});

describe("the forge's reads under the tick's bound", () => {
  const runtime = fakeRuntime(() => unanswered()).runtime;

  it("starts no repository query, comment listing or comments query once the bound has ended", async () => {
    const reads = tickReads(runtime, undefined, spent());
    expect(await reads.repository(REPO.path)).toEqual(
      failed("unreadable", `${PASSED} the repository's query was read`),
    );
    expect(await reads.comments.read(SLUG, 7)).toEqual(
      failed("unreadable", `${PASSED} the comments of #7 were listed`),
    );
    expect(await reads.pullRequestComments(SLUG, [7, 8])).toEqual(
      failed(
        "unreadable",
        `${PASSED} the merged pull requests' comments were read`,
      ),
    );
  });

  /** The forge's part of a tick under `bound`, its repository query answering `query`. */
  function forgeReads(
    query: Awaited<ReturnType<ForgeReads["repository"]>>,
    bound: TickBound,
  ): ForgeReads {
    return {
      repository: async () => query,
      pullRequestComments: async () => failed("unreadable", "not asked"),
      comments: tickComments({
        list: async () => failed("unreadable", "not asked"),
      }),
      login: async () => "drive-bot",
      pool: pool(),
      bound,
    };
  }

  const forgeSection = {
    followupCommand: "/followup",
    adopt: { enabled: false },
  } as unknown as DispatchSection;

  it("lists no pull requests on their own once the bound has ended, and reads them as unread", async () => {
    const report = emptyReport(REPO.path, "");
    const forge = await readForge(
      REPO,
      report,
      forgeSection,
      null,
      Date.now(),
      () => {
        throw new Error("no shared records are read");
      },
      forgeReads(failed("unreadable", "the query failed"), spent()),
    );
    expect(forge.ok).toBe(false);
    expect(report.records).toEqual([
      {
        record: "forge",
        source: `gh ${SLUG}`,
        ok: false,
        detail: `the pull requests cannot be read: ${PASSED} the pull requests were listed; the repository query did not read either: the query failed`,
      },
    ]);
  });

  it("lists no merges once the bound has ended", async () => {
    const report = {
      ...emptyReport(REPO.path, ""),
      followupSince: "2026-11-01T00:00:00.000Z",
    };
    const forge = await readForge(
      REPO,
      report,
      forgeSection,
      null,
      Date.now(),
      () => {
        throw new Error("no shared records are read");
      },
      forgeReads(
        ok({
          target: REPO,
          config: "",
          open: [],
          comments: new Map(),
          overflow: [],
          startedAtMs: Date.now(),
          pages: 1,
          cost: 1,
          pageSize: 50,
        }),
        spent(),
      ),
    );
    expect(forge.ok).toBe(false);
    expect(report.records.map((r) => r.detail)).toEqual([
      `the pull requests cannot be read: ${PASSED} the merged pull requests were listed`,
    ]);
  });
});

describe("a repository under the tick's bound", () => {
  it("is not opened once the bound has ended, and is refused with why", async () => {
    const runtime = fakeRuntime(() => unanswered()).runtime;
    const report = await openRepo(REPO.path, {
      options: { repos: [REPO.path] },
      nowMs: Date.now(),
      reads: tickReads(runtime),
      bound: spent(),
    });
    expect("refused" in report && report.refused).toBe(
      `${PASSED} this repository was opened, so nothing is planned for it this tick`,
    );
  });
});

describe("the tick's bound itself", () => {
  it("is absent for a tick no launcher bounds", () => {
    expect(deadlineOf(null, Date.now())).toBeUndefined();
    const context = {
      options: { repos: [] },
      startedMs: Date.now(),
    } as unknown as TickContext;
    expect(tickBound(context)).toBeUndefined();
    expect(boundAt(undefined)).toBeUndefined();
  });

  it("is made once, so every phase shares one signal", () => {
    const context = {
      options: {
        repos: [],
        machine: { runtimeTimeoutMs: 60_000, workspaceTimeoutMs: 60_000 },
      },
      startedMs: Date.now(),
    } as unknown as TickContext;
    const first = tickBound(context);
    expect(first).toBeDefined();
    expect(tickBound(context)).toBe(first as TickBound);
  });
});

describe("a tick whose bound ends before it reads", () => {
  it("refuses its repository with why, writes its receipt and lets its locks go", async () => {
    const w = world();
    try {
      w.setConfig(
        `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\ndispatch:\n  identity: factory-bot\n`,
      );
      w.setIssues([assignedIssue(12, "factory-bot", [])]);
      w.setAssigner(12, "maintainer", "WRITE");
      machineFile(w, [account(w, "a", "a@example.com")], {}, ["pickup"]);
      // A launcher deadline shorter than the receipt's share: the bound has ended as the tick starts.
      const bounded = await w.dispatch(["--json"], undefined, {
        JIG_LAUNCHER_DEADLINE_SEC: "1",
      });
      // A repository it could not read fails the tick, which still completes and writes its receipt.
      expectSpawnExit(bounded, 1);
      const receipt = JSON.parse(bounded.stdout) as TickReceipt;
      expect(receipt.completed).toBe(true);
      expect(receipt.lockHeldBy).toBeUndefined();
      expect(receipt.repos[0]?.refused).toBe(
        `${PASSED} this repository was opened, so nothing is planned for it this tick`,
      );
      expect(receipt.repos[0]?.records).toEqual([]);
      const written = join(
        dispatchState(w),
        "receipts",
        receipt.startedAt.slice(0, 10),
        `${receipt.runId}.json`,
      );
      expect(existsSync(written)).toBe(true);
      // The locks were let go: the next tick, its launcher's deadline as the machine file sets it, reads the repository whole.
      const next = await w.dispatch(["--json"]);
      expectSpawnExit(next, 0);
      const after = JSON.parse(next.stdout) as TickReceipt;
      expect(after.lockHeldBy).toBeUndefined();
      expect(after.repos[0]?.refused).toBeNull();
      expect(
        after.repos[0]?.records.find((r) => r.record === "tracker")?.ok,
      ).toBe(true);
    } finally {
      w.close();
    }
  });
});
