/**
 * line-merge.ts: a tick that read only some repositories replaces their part
 * of the line and keeps the rest, each entry marked with the tick it is from.
 */
import { describe, expect, test } from "bun:test";
import type {
  LineNeed,
  LineQueued,
  LineRepo,
  LineSession,
  LineSnapshot,
} from "../lib/dashboard-contract.ts";
import { mergeLine, readBy } from "../lib/line-merge.ts";

const LISTED = [{ path: "/w/a" }, { path: "/w/b" }];

function repo(slug: string, path: string): LineRepo {
  return {
    slug,
    path,
    stages: ["pickup"],
    refused: null,
    failedReads: [],
    notes: [],
  };
}

function need(slug: string, target: string): LineNeed {
  return {
    cause: "stalled",
    stage: "pickup",
    repo: slug,
    target,
    pr: null,
    item: target,
    url: null,
    title: null,
    since: "2026-11-10T10:00:00.000Z",
    reason: "stalled",
    decisions: [],
    notified: null,
    workspaces: [],
  };
}

function queued(slug: string, target: string): LineQueued {
  return {
    source: "assigned",
    group: "never",
    repo: slug,
    target,
    pr: null,
    item: target,
    url: null,
    title: null,
    why: "held",
    stale: false,
    assignedBy: null,
    hold: null,
    launch: null,
  };
}

function session(slug: string, target: string): LineSession {
  return {
    record: `${slug} ${target}`,
    account: "a",
    vendor: "claude",
    repo: slug,
    stage: "pickup",
    target,
    pr: null,
    item: target,
    url: null,
    title: null,
    createdAt: "2026-11-10T10:00:00.000Z",
    launch: "alive",
    launchReason: null,
    agent: null,
    round: null,
    samples: [],
    heartbeat: null,
    passTimeoutSec: null,
    workspace: null,
    replaces: null,
    episode: null,
    nudge: null,
    drifting: null,
    waiting: null,
  };
}

/** The line one tick built from the repositories it read, as `buildLine` leaves it. */
function tickLine(
  startedAt: string,
  parts: Array<{ slug: string; path: string; n: number }>,
): LineSnapshot {
  return readBy(
    {
      version: 1,
      runId: startedAt,
      startedAt,
      finishedAt: startedAt,
      exitStatus: 0,
      apply: true,
      applyWithheld: null,
      intervalMs: 120_000,
      longestTickMs: 60_000,
      plugin: null,
      accounts: [],
      lastAccount: null,
      sessions: parts.map((p) => session(p.slug, `${p.slug}-S${p.n}`)),
      needs: parts.map((p) => need(p.slug, `${p.slug}-N${p.n}`)),
      queue: parts.map((p) => queued(p.slug, `${p.slug}-Q${p.n}`)),
      ready: [],
      repos: parts.map((p) => repo(p.slug, p.path)),
    },
    startedAt,
    startedAt,
  );
}

describe("mergeLine", () => {
  test("a repository the tick reported on without a slug loses its old cards with its old entry", () => {
    const before = tickLine("2026-11-10T10:00:00.000Z", [
      { slug: "A", path: "/w/a", n: 0 },
      { slug: "B", path: "/w/b", n: 0 },
    ]);
    const failed = readBy(
      {
        ...tickLine("2026-11-10T10:02:00.000Z", []),
        repos: [{ ...repo("B", "/w/b"), slug: null }],
      },
      "2026-11-10T10:02:00.000Z",
      "2026-11-10T10:02:00.000Z",
    );
    const line = mergeLine(before, failed, LISTED, "fresh");
    expect(line.needs.map((x) => x.repo)).toEqual(["A"]);
    expect(line.sessions.map((x) => x.repo)).toEqual(["A"]);
  });

  test("keeps the busy repository's part from the tick that last read it while the other stays current", () => {
    const at = (minute: number) =>
      `2026-11-10T10:${String(minute).padStart(2, "0")}:00.000Z`;
    let line = tickLine(at(0), [
      { slug: "A", path: "/w/a", n: 0 },
      { slug: "B", path: "/w/b", n: 0 },
    ]);
    // Repository B is busy on every one of the next three ticks.
    for (const n of [1, 2, 3])
      line = mergeLine(
        line,
        tickLine(at(n * 2), [{ slug: "A", path: "/w/a", n }]),
        LISTED,
        "fresh",
      );
    expect(line.runId).toBe(at(6));
    expect(line.needs.map((x) => x.target)).toEqual(["B-N0", "A-N3"]);
    expect(line.queue.map((x) => x.target)).toEqual(["B-Q0", "A-Q3"]);
    expect(line.sessions.map((x) => x.target)).toEqual(["B-S0", "A-S3"]);
    expect(line.repos.map((r) => [r.slug, r.runId, r.readAt])).toEqual([
      ["A", at(6), at(6)],
      ["B", at(0), at(0)],
    ]);
  });

  test("keeps the machine's part from the line before for a wake-up, and still replaces the parts it read", () => {
    const before = tickLine("2026-11-10T09:00:00.000Z", [
      { slug: "A", path: "/w/a", n: 0 },
      { slug: "B", path: "/w/b", n: 0 },
    ]);
    const woken = mergeLine(
      before,
      tickLine("2026-11-10T09:01:00.000Z", [{ slug: "A", path: "/w/a", n: 1 }]),
      LISTED,
      "kept",
    );
    expect(woken.runId).toBe(before.runId);
    expect(woken.startedAt).toBe(before.startedAt);
    expect(woken.needs.map((x) => x.target)).toEqual(["B-N0", "A-N1"]);
    expect(woken.repos.map((r) => r.readAt)).toEqual([
      "2026-11-10T09:01:00.000Z",
      "2026-11-10T09:00:00.000Z",
    ]);
  });

  test("marks a kept entry from a line written before entries carried their tick with that line's tick", () => {
    const old = tickLine("2026-11-10T09:00:00.000Z", [
      { slug: "B", path: "/w/b", n: 0 },
    ]);
    const {
      readAt: _read,
      runId: _run,
      ...unmarked
    } = old.repos[0] as LineRepo;
    const merged = mergeLine(
      { ...old, repos: [unmarked] },
      tickLine("2026-11-10T09:02:00.000Z", [{ slug: "A", path: "/w/a", n: 1 }]),
      LISTED,
      "fresh",
    );
    expect(merged.repos.map((r) => [r.slug, r.readAt])).toEqual([
      ["A", "2026-11-10T09:02:00.000Z"],
      ["B", "2026-11-10T09:00:00.000Z"],
    ]);
  });

  test("drops a repository the machine file no longer lists, and keeps the host's load until a tick reads one", () => {
    const old = {
      ...tickLine("2026-11-10T09:00:00.000Z", [
        { slug: "A", path: "/w/a", n: 0 },
        { slug: "C", path: "/w/c", n: 0 },
      ]),
      load: {
        enforce: false,
        factor: 0.5,
        binds: null,
        gauges: [],
        reservations: [],
        holds: [],
      },
    };
    const merged = mergeLine(
      old,
      tickLine("2026-11-10T09:02:00.000Z", [{ slug: "B", path: "/w/b", n: 1 }]),
      LISTED,
      "fresh",
    );
    expect(merged.repos.map((r) => r.slug)).toEqual(["A", "B"]);
    expect(merged.needs.map((x) => x.target)).toEqual(["A-N0", "B-N1"]);
    expect(merged.load?.factor).toBe(0.5);
  });
});
