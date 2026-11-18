/**
 * dispatch: one bound for a tick its launcher bounds. Every read of the
 * observe phase keeps to it: the tracker's assigner, claimed-item and
 * claim-marker reads and the runtime's sessions are given its signal where
 * their transport takes one and held to it either way, the forge's listings
 * and paged queries ask nothing after it ends, a read it cut short goes on
 * the report as a failed read of class `unreachable`, and the tick still
 * writes its receipt and lets its locks go. A tick no launcher bounds has no
 * bound, and reads as it always did.
 */
import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
import { boundAt, passedRead, type TickBound } from "../lib/sources/bounded.ts";
import { outboundOf } from "../../shared/outbound/failure.ts";
import { markClaims } from "../lib/sources/claim-markers.ts";
import { readPickups } from "../lib/sources/tracker.ts";
import { facetBound } from "../lib/sources/tracker-facets.ts";
import {
  type AskComments,
  type AskPage,
  readComments,
  readRepository,
} from "../lib/forge-batch.ts";
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
import {
  assignedIssue,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  world,
} from "./fixtures.ts";
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
    async listRelations() {
      return [];
    },
    async poolIssue(key: string) {
      return issues.find((issue) => issue.identifier === key) ?? null;
    },
    async getIssue(key: string) {
      return { identifier: key, description: "", parent: null };
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
    // Each is a failed read, so the tick reports it rather than exiting clean.
    expect(reading.unplaced.every((u) => u.readFailed === true)).toBe(true);
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
    expect(
      reading.unplaced
        .filter((u) => u.target === "#1" || u.target === "#2")
        .map((u) => u.readFailed),
    ).toEqual([true, true]);
  });

  it("reads no claim marker once the bound has ended, and stops one in flight, each a failed read", async () => {
    const asked: string[] = [];
    const tracker = {
      adapter: "github",
      team: SLUG,
      issueComments: (key: string) => {
        asked.push(key);
        return unanswered();
      },
    } as unknown as Tracker;
    const cache = { get: () => null, set: () => undefined };
    const claimed = ["#1", "#2"].map((key) => ({
      key,
      title: key,
      url: null,
      state: "In Progress",
    }));
    const skipped = await markClaims(
      tracker,
      "factory",
      claimed,
      cache,
      spent(),
    );
    expect(asked).toEqual([]);
    expect(skipped.claimed.map((c) => c.claimMarker)).toEqual([
      "unread",
      "unread",
    ]);
    expect(skipped.unplaced.map((u) => u.readFailed)).toEqual([true, true]);
    const stopped = await markClaims(
      tracker,
      "factory",
      claimed,
      cache,
      endsIn(50),
    );
    expect(asked).toEqual(["#1"]);
    expect(stopped.unplaced.map((u) => [u.target, u.readFailed])).toEqual([
      ["#1", true],
      ["#2", true],
    ]);
    expect(stopped.unplaced[0]?.reason).toContain(
      "stopped at the tick's deadline",
    );
  });

  it("stops new factory metadata reads at the same tick deadline", async () => {
    const fake = fakeTracker([item("#1")], trusted);
    fake.tracker.listRelations = () =>
      new Promise(() => {
        /* The shared view must stop waiting at the deadline. */
      });
    const tick = endsIn(50);
    const reading = await readPickups(() => fake.tracker, section, {
      bound: () => facetBound(undefined),
      tick,
    });
    expect(reading.wanted).toEqual([]);
    expect(reading.claimed).toBeNull();
    expect(
      reading.unplaced.some((row) =>
        row.reason.includes("stopped at the tick's deadline"),
      ),
    ).toBe(true);
    expect(fake.assigners).toEqual([{ key: "#1", signal: tick.signal }]);
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
      failure: { class: "unreachable" },
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
      failure: { class: "unreachable" },
    });
  });

  it("reads as before when the tick has no bound", async () => {
    const answer: SessionsReport = { ok: true, source: "fake", workspaces: [] };
    const { runtime, signals } = fakeRuntime(async () => answer);
    expect(await readSessions(runtime, REPO, JOIN)).toMatchObject(answer);
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

  it("starts no repository query, comment listing, comments query or login read once the bound has ended", async () => {
    const reads = tickReads(runtime, undefined, spent());
    expect(await reads.repository(REPO.path)).toEqual(
      passedRead("the repository's query was read"),
    );
    expect(await reads.comments.read(SLUG, 7)).toEqual(
      passedRead("the comments of #7 were listed"),
    );
    expect(await reads.pullRequestComments(SLUG, [7, 8])).toEqual(
      passedRead("the merged pull requests' comments were read"),
    );
    const read = await reads.repository(REPO.path);
    expect(read.ok ? null : outboundOf(read.failure)?.code).toBe("unreachable");
    // No login is asked after the deadline, and its absence is a deadline failure, never a missing login.
    await expect(reads.login()).rejects.toMatchObject({
      code: "unreachable",
    });
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
        failure: { class: "unreachable" },
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

describe("a paged forge query under the tick's bound", () => {
  /** One page of `size` pull requests after `after`, of a repository with more after it. */
  const pageOf = (after: string | null, size: number) => {
    const from = after === null ? 0 : Number(after);
    return ok({
      data: {
        rateLimit: { cost: 1, remaining: 4990 },
        repository: {
          nameWithOwner: SLUG,
          defaultBranchRef: { name: "main", target: { file: null } },
          pullRequests: {
            pageInfo: { hasNextPage: true, endCursor: String(from + size) },
            nodes: Array.from({ length: size }, (_, i) => ({
              number: from + i + 1,
              headRefName: `feature/${from + i + 1}`,
              labels: { pageInfo: { hasNextPage: false }, nodes: [] },
              comments: {
                totalCount: 0,
                pageInfo: { hasNextPage: false },
                nodes: [],
              },
            })),
          },
        },
      },
    });
  };

  it("asks no page after the bound ends, and fails as unreachable", async () => {
    const bound = endsIn(60_000);
    const asked: Array<string | null> = [];
    const ask: AskPage = async (_path, after, size) => {
      asked.push(after);
      // The bound ends while the first page is answered.
      if (after === null) bound.deadline = Date.now() - 1;
      return pageOf(after, size);
    };
    const read = await readRepository(REPO.path, undefined, ask, bound);
    expect(asked).toEqual([null]);
    expect(read).toEqual(
      passedRead("the next page of pull requests was asked"),
    );
    expect(read.ok ? null : outboundOf(read.failure)?.code).toBe("unreachable");
  });

  it("asks no smaller comments query after the bound ends", async () => {
    const bound = endsIn(60_000);
    const asked: number[] = [];
    const ask: AskComments = async (_owner, _name, prs) => {
      asked.push(prs.length);
      bound.deadline = Date.now() - 1;
      return failed("too-costly", "gh api graphql exited 1: gh: HTTP 504");
    };
    const read = await readComments(SLUG, [1, 2, 3, 4], undefined, ask, bound);
    expect(asked).toEqual([4]);
    expect(read.ok ? null : outboundOf(read.failure)?.code).toBe("unreachable");
  });

  it("reads every page when the query has no bound", async () => {
    let pages = 0;
    const ask: AskPage = async (_path, after, size) => {
      pages += 1;
      const page = pageOf(after, size);
      if (pages === 3 && page.ok)
        page.value.data.repository.pullRequests.pageInfo.hasNextPage = false;
      return page;
    };
    const read = await readRepository(REPO.path, undefined, ask);
    expect(pages).toBe(3);
    expect(read.ok).toBe(true);
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

  it("starts no read one by one when the bound ends during its query", async () => {
    const bound = endsIn(60_000);
    const controller = new AbortController();
    const cut: TickBound = { ...bound, signal: controller.signal };
    const reads = tickReads(fakeRuntime(() => unanswered()).runtime);
    let started = 0;
    const run = reads.pool.run.bind(reads.pool);
    reads.pool.run = (read) => {
      started += 1;
      return run(read);
    };
    reads.repository = async () => {
      controller.abort(new Error("the tick's deadline passed"));
      return passedRead("the repository was queried");
    };
    const report = await openRepo(REPO.path, {
      options: { repos: [REPO.path] },
      nowMs: Date.now(),
      reads,
      bound: cut,
    });
    expect(started).toBe(0);
    expect("refused" in report && report.refused).toBe(
      `${PASSED} this repository was opened, so nothing is planned for it this tick`,
    );
    expect("refusedBy" in report && report.refusedBy?.class).toBe(
      "unreachable",
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
      // The refusal is an `unreachable` read the tick waits out; it still completes and writes its receipt.
      expectSpawnExit(bounded, 0);
      const receipt = JSON.parse(bounded.stdout) as TickReceipt;
      expect(receipt.completed).toBe(true);
      expect(receipt.lockHeldBy).toBeUndefined();
      expect(receipt.repos[0]?.refused).toStartWith(
        `${PASSED} this repository was opened, so nothing is planned for it this tick`,
      );
      expect(receipt.repos[0]?.refusedBy?.class).toBe("unreachable");
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

describe("a tick whose bound ends after it opened its repository", () => {
  it("cuts the forge's reading as unreachable, starts no base-head read after it, writes its receipt and lets its locks go", async () => {
    const w = world();
    try {
      w.setConfig(
        `issue_tracker:\n  adapter: github\n  github:\n    repository: ${SLUG}\n`,
      );
      // PR #7's drive stopped on a conflict with its base: reading it reads its base branch's head.
      w.setPrs("open", [
        openPr(7, "feature/7-conflict", { mergeable: "CONFLICTING" }),
      ]);
      w.setComments(7, [ledgerComment(701, stoppedLedger(7, 9))]);
      machineFile(w, [account(w, "a", "a@example.com")], {
        runtime_timeout: "1s",
      });
      // The login read, made once the repository is open, is answered only after the tick's deadline.
      const hold = join(w.dir, "gh-hold.json");
      writeFileSync(
        hold,
        JSON.stringify({ match: "api user --jq .login", ms: 15_000 }),
      );
      // The launcher's deadline less the runtime's share leaves a bound of nine seconds, ample to open the repository under load.
      const bounded = await w.dispatch(["--json"], undefined, {
        JIG_LAUNCHER_DEADLINE_SEC: "10",
      });
      expectSpawnExit(bounded, 0);
      const receipt = JSON.parse(bounded.stdout) as TickReceipt;
      expect(receipt.completed).toBe(true);
      expect(receipt.lockHeldBy).toBeUndefined();
      expect(receipt.repos[0]?.refused).toBeNull();
      const forge = receipt.repos[0]?.records.find((r) => r.record === "forge");
      expect(forge).toMatchObject({
        ok: false,
        failure: { class: "unreachable" },
      });
      expect(forge?.detail).toContain(
        "the tick's deadline passed during the pull requests were read",
      );
      const calls = readFileSync(join(w.dir, "gh-calls.log"), "utf8");
      expect(calls).toContain("api user --jq .login");
      expect(existsSync(join(w.dir, "base-reads.log"))).toBe(false);
      const written = join(
        dispatchState(w),
        "receipts",
        receipt.startedAt.slice(0, 10),
        `${receipt.runId}.json`,
      );
      expect(existsSync(written)).toBe(true);
      // The locks were let go: the next tick, nothing held, reads the forge whole.
      writeFileSync(hold, JSON.stringify({ match: "no call", ms: 0 }));
      const next = await w.dispatch(["--json"]);
      expectSpawnExit(next, 0);
      const after = JSON.parse(next.stdout) as TickReceipt;
      expect(after.lockHeldBy).toBeUndefined();
      expect(
        after.repos[0]?.records.find((r) => r.record === "forge")?.ok,
      ).toBe(true);
    } finally {
      w.close();
    }
  }, 60_000);
});
