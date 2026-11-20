/**
 * line-keyless.ts: a tick that had no credential for a repository's tracker
 * keeps that repository's tracker part of the line (its item cards and
 * needs) from the last reading that had one, marked with that reading's time
 * and the reason; what it read of the forge is its own.
 */
import { expect, test } from "bun:test";
import type {
  LineNeed,
  LineQueued,
  LineRepo,
  LineSnapshot,
} from "../lib/dashboard-contract.ts";
import { keepTrackerPart } from "../lib/line-keyless.ts";

const READ = "2026-11-20T10:00:00.000Z";
const KEYLESS = "2026-11-20T10:05:00.000Z";

function repo(slug: string, runId: string, readAt: string): LineRepo {
  return {
    slug,
    path: `/w/${slug}`,
    stages: ["pickup", "followup"],
    tracker: { adapter: slug === "lin" ? "linear" : "github" },
    refused: null,
    failedReads: [],
    notes: [],
    runId,
    readAt,
  };
}

function need(slug: string, target: string, pr: number | null): LineNeed {
  return {
    cause: pr === null ? "stalled" : "parked",
    stage: "pickup",
    repo: slug,
    target,
    pr,
    item: pr === null ? target : null,
    url: null,
    title: null,
    since: READ,
    reason: "waits",
    decisions: [],
    notified: null,
    workspaces: [],
  };
}

function card(slug: string, target: string, pr: number | null): LineQueued {
  return {
    source: pr === null ? "assigned" : "merged",
    group: "starts",
    repo: slug,
    target,
    pr,
    item: pr === null ? target : null,
    url: null,
    title: null,
    why: "ready",
    stale: false,
    assignedBy: null,
    hold: null,
    launch: null,
  };
}

function line(
  runId: string,
  at: string,
  parts: { needs: LineNeed[]; queue: LineQueued[] },
): LineSnapshot {
  return {
    version: 1,
    runId,
    startedAt: at,
    finishedAt: at,
    exitStatus: 0,
    apply: true,
    applyWithheld: null,
    intervalMs: 120_000,
    longestTickMs: 60_000,
    plugin: null,
    accounts: [],
    lastAccount: null,
    sessions: [],
    needs: parts.needs,
    queue: parts.queue,
    ready: [],
    repos: [repo("lin", runId, at), repo("gh", runId, at)],
  };
}

test("a keyless tick keeps a Linear-tracked repository's cards and needs from the last reading with a credential, marked with its time and the reason", () => {
  const before = line("read", READ, {
    needs: [need("lin", "ENG-1", null), need("gh", "#3", null)],
    queue: [card("lin", "ENG-2", null), card("lin", "PR #9", 9)],
  });
  // The keyless tick's own reading: no tracker items for the Linear repository, a fresh forge card, a fresh park.
  const fresh = line("keyless", KEYLESS, {
    needs: [need("lin", "PR #4", 4), need("gh", "#5", null)],
    queue: [card("lin", "PR #10", 10)],
  });
  const kept = keepTrackerPart(fresh, before, {
    runId: "keyless",
    systems: new Map([["linear", "no Linear key configured"]]),
  });
  expect(kept.needs.map((n) => n.target).sort()).toEqual(
    ["#5", "ENG-1", "PR #4"].sort(),
  );
  expect(kept.queue.map((q) => q.target).sort()).toEqual(
    ["ENG-2", "PR #10"].sort(),
  );
  const lin = kept.repos.find((r) => r.slug === "lin");
  expect(lin?.trackerKept).toEqual({
    readAt: READ,
    runId: "read",
    reason: "no Linear key configured",
  });
  expect(kept.repos.find((r) => r.slug === "gh")?.trackerKept).toBeUndefined();
});

test("a second keyless tick keeps the time of the last reading that had a credential", () => {
  const before = line("read", READ, {
    needs: [need("lin", "ENG-1", null)],
    queue: [card("lin", "ENG-2", null)],
  });
  const first = keepTrackerPart(
    line("keyless", KEYLESS, { needs: [], queue: [] }),
    before,
    {
      runId: "keyless",
      systems: new Map([["linear", "no Linear key configured"]]),
    },
  );
  const second = keepTrackerPart(
    line("again", "2026-11-20T10:10:00.000Z", { needs: [], queue: [] }),
    first,
    {
      runId: "again",
      systems: new Map([["linear", "no Linear key configured"]]),
    },
  );
  expect(second.needs.map((n) => n.target)).toEqual(["ENG-1"]);
  expect(second.queue.map((q) => q.target)).toEqual(["ENG-2"]);
  expect(second.repos.find((r) => r.slug === "lin")?.trackerKept).toEqual({
    readAt: READ,
    runId: "read",
    reason: "no Linear key configured",
  });
});

test("a tick with a credential leaves the line as it read it", () => {
  const before = line("read", READ, {
    needs: [need("lin", "ENG-1", null)],
    queue: [],
  });
  const fresh = line("next", KEYLESS, { needs: [], queue: [] });
  expect(
    keepTrackerPart(fresh, before, { runId: "next", systems: new Map() }),
  ).toBe(fresh);
});

test("a repository the system's incident does not name keeps its fresh tracker part", () => {
  const before = line("read", READ, {
    needs: [need("lin", "ENG-1", null)],
    queue: [card("lin", "ENG-2", null)],
  });
  const fresh = line("keyless", KEYLESS, {
    needs: [need("lin", "ENG-7", null)],
    queue: [card("lin", "ENG-8", null)],
  });
  const kept = keepTrackerPart(fresh, before, {
    runId: "keyless",
    systems: new Map([["linear", "no Linear key configured"]]),
    only: new Map([["linear", new Set(["other"])]]),
  });
  expect(kept.needs.map((n) => n.target)).toEqual(["ENG-7"]);
  expect(kept.queue.map((q) => q.target)).toEqual(["ENG-8"]);
  expect(kept.repos.find((r) => r.slug === "lin")?.trackerKept).toBeUndefined();
});
