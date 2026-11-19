import { describe, expect, it } from "bun:test";
import { ok as assert } from "node:assert/strict";
import type {
  LineAccount,
  LineRefusal,
  LineRepo,
  LineSession,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { fixture } from "../fixtures.ts";
import { ROLES } from "./status.ts";
import {
  accountView,
  type Clock,
  isOverdue,
  isStuck,
  nextFreeAccount,
  repoRow,
  repoSummary,
  sessionKind,
  slotSummary,
  slotView,
  freshOf,
  staleBanners,
  timerBanner,
} from "./view.ts";

const NOW = Date.UTC(2026, 10, 3, 16, 47, 30);
const CLOCK: Clock = { nowMs: NOW, timeZone: "UTC" };
const iso = (hour: number, minute: number) =>
  new Date(Date.UTC(2026, 10, 3, hour, minute)).toISOString();

function lineOf(id: Parameters<typeof fixture>[0]): LineSnapshot {
  const { line } = fixture(id);
  if (line === null) throw new Error(`the ${id} scenario has no line`);
  return line;
}

const SESSION: LineSession = {
  record: "20261103T150000Z-aa",
  account: "work-a",
  vendor: "claude",
  repo: "example-org/web",
  stage: "rearm",
  target: "PR #7",
  pr: 7,
  item: null,
  url: "https://forge.example/example-org/web/pull/7",
  title: "Fix the thing",
  createdAt: iso(15, 30),
  launch: "alive",
  launchReason: null,
  agent: null,
  round: 3,
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

const LINE: LineSnapshot = { ...lineOf("quiet"), sessions: [SESSION] };

function factOf(change: Partial<LineSession>): string {
  return slotView({ ...SESSION, ...change }, CLOCK, LINE).fact;
}

describe("slotView link text", () => {
  it("says what is missing on a card whose link is not known, and nothing on one that has it", () => {
    expect(slotView({ ...SESSION, url: null }, CLOCK, LINE).noLink).toContain(
      SESSION.target,
    );
    expect(
      slotView({ ...SESSION, url: "https://x.test/1" }, CLOCK, LINE).noLink,
    ).toBeNull();
  });
});

function evidenceOf(change: Partial<LineSession>): Record<string, string> {
  return Object.fromEntries(
    slotView({ ...SESSION, ...change }, CLOCK, LINE).evidence.map((row) => [
      row.k,
      row.v,
    ]),
  );
}

const WALL_PASSED = {
  observedAt: iso(15, 22),
  resetAt: iso(16, 10),
  evidence: "usage limit reached",
  last: true,
};

describe("a session's fact", () => {
  it("says a launch record is unknown and holds its slot, whatever else it says", () => {
    const change: Partial<LineSession> = {
      launch: "unknown",
      launchReason: "a claim from another boot",
      agent: { state: "working", since: null },
      drifting: "threads are flat",
      stage: "takeover",
    };
    expect(factOf(change)).toBe(
      "launch record unknown, 1 h 17 min, holds its slot",
    );
    const evidence = evidenceOf(change);
    expect(evidence.why).toBe("a claim from another boot");
    expect(evidence["to release"]).toBe("a person runs jig dispatch clear");
    const release = slotView(
      { ...SESSION, ...change },
      CLOCK,
      LINE,
    ).evidence.find((row) => row.k === "to release");
    expect(release?.copy).toBe("jig dispatch clear");
  });

  it("says a pending launch was not claimed, naming this tick only when it was launched in it", () => {
    expect(factOf({ launch: "pending", createdAt: LINE.startedAt })).toBe(
      "pending, launched this tick, not claimed yet",
    );
    expect(factOf({ launch: "pending", createdAt: iso(16, 0) })).toBe(
      "pending, not claimed yet",
    );
  });

  it("says a pending launch no tick launches again needs a person, with why and how to release it", () => {
    const change: Partial<LineSession> = {
      launch: "pending",
      stuck: "none of its 2 launches was answered as started (lost, lost)",
    };
    const view = slotView({ ...SESSION, ...change }, CLOCK, LINE);
    expect(view.kind).toBe("stuck");
    expect(isStuck(view.kind)).toBe(true);
    expect(view.role).toBe(ROLES.needs);
    expect(view.fact).toBe(
      "launch record stuck pending, 1 h 17 min, needs a person",
    );
    const evidence = evidenceOf(change);
    expect(evidence.why).toContain("(lost, lost)");
    const release = view.evidence.find((row) => row.k === "to release");
    expect(release?.copy).toBe(`jig dispatch clear ${SESSION.record}`);
    expect(
      sessionKind({ ...SESSION, launch: "pending", stuck: null }, NOW),
    ).toBe("pending");
  });

  it("states a wait past its wall's reset, with the nudge when one was sent", () => {
    const waiting = {
      agent: { state: "waiting", since: iso(15, 22) },
      episode: WALL_PASSED,
    };
    expect(
      factOf({
        ...waiting,
        nudge: { at: iso(16, 15), delivery: "sent", detail: "" },
      }),
    ).toBe("waiting 1 h 25 min, wall reset passed 16:10, nudge sent 16:15");
    expect(factOf(waiting)).toBe("waiting 1 h 25 min, wall reset passed 16:10");
    expect(evidenceOf(waiting)["kind of wait"]).toBe(
      "usage limit (waiting episode)",
    );
  });

  it("states a wait with no wall as kind not reported", () => {
    const blocked = { agent: { state: "blocked", since: iso(16, 21) } };
    expect(factOf(blocked)).toBe("blocked 26 min, kind not reported");
    expect(evidenceOf(blocked)["kind of wait"]).toBe(
      "not reported by the runtime",
    );
  });

  it("leaves out how long when the runtime does not say", () => {
    expect(factOf({ agent: { state: "blocked", since: null } })).toBe(
      "blocked, kind not reported",
    );
  });

  it("does not read a wall that is no longer the session's last record as the cause", () => {
    expect(
      factOf({
        agent: { state: "blocked", since: iso(16, 21) },
        episode: { ...WALL_PASSED, last: false },
      }),
    ).toBe("blocked 26 min, kind not reported");
  });

  it("names a wall still standing, or one whose reset is not known", () => {
    const agent = { state: "waiting", since: iso(16, 21) };
    expect(
      factOf({ agent, episode: { ...WALL_PASSED, resetAt: iso(17, 10) } }),
    ).toBe("waiting 26 min, wall lifts 17:10");
    expect(factOf({ agent, episode: { ...WALL_PASSED, resetAt: null } })).toBe(
      "waiting 26 min, wall reset unknown",
    );
  });

  it("counts a drift's flat rounds from the samples, with its reason verbatim in the evidence", () => {
    const samples = [6, 6, 6, 6].map((threads, i) => ({
      round: i + 5,
      threads,
      at: iso(15, i),
    }));
    const change = { samples, drifting: "threads are flat past the limit" };
    expect(factOf(change)).toBe("drifting, threads flat 3 rounds: 6 6 6 6");
    expect(evidenceOf(change).expectation).toBe(
      "threads are flat past the limit",
    );
    expect(evidenceOf(change)["threads by round"]).toBe("6 6 6 6");
  });

  it("says only drifting when too few samples show a trend", () => {
    expect(factOf({ drifting: "no pull request in time" })).toBe("drifting");
  });

  it("states a takeover with what it replaced", () => {
    const change = {
      stage: "takeover" as const,
      createdAt: iso(16, 20),
      replaces: "20261103T151002Z-ef",
    };
    expect(factOf(change)).toBe(
      "working, took over a stalled driver 27 min ago",
    );
    expect(evidenceOf(change).replaces).toBe("20261103T151002Z-ef");
  });

  it("says working, with the round when a record holds one", () => {
    expect(factOf({})).toBe("working, round 3, 1 h 17 min");
    expect(factOf({ round: null })).toBe("working, 1 h 17 min");
  });

  it("prints the runtime's own word for a state it is not working in", () => {
    const view = slotView(
      { ...SESSION, agent: { state: "done", since: null } },
      CLOCK,
      LINE,
    );
    expect(view.fact).toBe("done, round 3, 1 h 17 min");
    expect(view.role).toBe(ROLES.well);
  });

  it("leaves out of the evidence what the record does not hold", () => {
    const evidence = evidenceOf({ title: null, url: null });
    expect(Object.keys(evidence)).toEqual(["repository", "launched", "record"]);
  });

  it("claims no round limit", () => {
    const samples = [{ round: 3, threads: 5, at: iso(15, 0) }];
    expect(evidenceOf({ samples }).round).toBe("3");
  });

  it("says a pass deadline of zero is none", () => {
    expect(evidenceOf({ passTimeoutSec: 0 })["pass deadline"]).toBe("none");
    expect(evidenceOf({ passTimeoutSec: 2700 })["pass deadline"]).toBe(
      "45 min",
    );
  });
});

describe("which sessions are not moving", () => {
  it("holds those waiting, blocked, drifting or unknown", () => {
    const kinds = lineOf("hung").sessions.map((s) => sessionKind(s, NOW));
    expect(kinds).toEqual([
      "waitOther",
      "takeover",
      "waitWall",
      "drift",
      "unknown",
    ]);
    expect(kinds.filter(isStuck).length).toBe(4);
  });

  it("leaves out working, pending and a takeover", () => {
    expect(isStuck("working")).toBe(false);
    expect(isStuck("pending")).toBe(false);
    expect(isStuck("takeover")).toBe(false);
  });
});

describe("staleness", () => {
  const line = lineOf("quiet");

  it("is how old the tick is, and when the next is due", () => {
    expect(freshOf(line, CLOCK, false)).toEqual({
      short: "Updated 2 min ago",
      detail: [
        "The running, needs-you and queue panels show what the 16:45 tick found, host time; the log is read on its own.",
        "The next tick is due 16:50.",
      ],
      alarm: false,
    });
  });

  it("alarms only past the interval plus the longest tick", () => {
    const start = Date.parse(line.startedAt);
    const edge = start + line.intervalMs + line.longestTickMs;
    expect(isOverdue(line, edge)).toBe(false);
    expect(isOverdue(line, edge + 1)).toBe(true);
    expect(
      freshOf(line, { nowMs: edge + 60_000, timeZone: "UTC" }, false),
    ).toEqual({
      short: "Updated 8 min ago · overdue",
      detail: [
        "The running, needs-you and queue panels show what the 16:45 tick found, host time; the log is read on its own.",
        "The next tick was due 16:50; it is 3 min overdue.",
      ],
      alarm: true,
    });
  });

  it("says how long the timer has been silent", () => {
    const stopped = lineOf("stopped");
    expect(timerBanner(stopped, CLOCK).title).toBe(
      "The timer has not ticked for 47 min.",
    );
    expect(timerBanner(stopped, CLOCK).body).toContain(
      "Everything below is as of the 16:00 tick",
    );
  });

  it("names a repository no tick has read since its part, and why", () => {
    const partial = lineOf("partial");
    expect(staleBanners(partial, CLOCK)).toEqual([
      {
        key: "/srv/work/mobile",
        title: "example-org/mobile has not been read since 16:05, 42 min ago.",
        body: expect.stringMatching(
          /^Another tick held it busy on \d+ of the \d+ ticks since, so none of them read it\. Its needs, queue and sessions below are as of the 16:05 tick\.$/,
        ),
      },
    ]);
  });

  it("names no repository whose part is within the timer's next tick, or a line that keeps no parts", () => {
    const partial = lineOf("partial");
    const read = Date.parse(
      partial.repos.find((r) => r.slug === "example-org/mobile")?.readAt ?? "",
    );
    const edge = read + partial.intervalMs + partial.longestTickMs;
    expect(staleBanners(partial, { nowMs: edge, timeZone: "UTC" })).toEqual([]);
    expect(staleBanners(lineOf("loud"), CLOCK)).toEqual([]);
    const notBusy = {
      ...partial,
      ticks: (partial.ticks ?? []).map((t) => ({ ...t, busy: [] })),
    };
    expect(staleBanners(notBusy, CLOCK)[0]?.body).toStartWith("None of the ");
  });

  it("says a repository's part is old because the newest tick that tried could not identify it", () => {
    const partial = lineOf("partial");
    const refusal = "the forge cannot say which repository this is";
    const refused = {
      ...partial,
      repos: partial.repos.map((r) =>
        r.slug === "example-org/mobile"
          ? { ...r, slug: null, lastSlug: r.slug, refused: refusal }
          : r,
      ),
    };
    expect(staleBanners(refused, CLOCK)).toEqual([
      {
        key: "/srv/work/mobile",
        title: "example-org/mobile has not been read since 16:05, 42 min ago.",
        body: `The newest tick that tried could not read it (${refusal}). Its needs, queue and sessions below are as of the 16:05 tick.`,
      },
    ]);
  });

  /** `count` stale repositories one rate limit on `account` refused, read a minute apart from 16:10. */
  function refusedRepos(count: number, start = 0, account = "one") {
    const [template] = lineOf("partial").repos;
    assert(template);
    return Array.from({ length: count }, (_, index) => {
      const number = start + index;
      return {
        ...template,
        slug: `example-org/repo-${number}`,
        path: `/repos/${number}`,
        readAt: `2026-11-03T16:${10 + number}:00Z`,
        refused: `rate limit; last reading for repository ${number}`,
        refusal: {
          step: "lookup" as const,
          failure: {
            class: "rate-limited" as const,
            account,
            until: "2026-11-03T17:00:00.000Z",
          },
        },
      };
    });
  }

  it("tells eight repositories one cause refused in one banner, each with its last read", () => {
    const repos = refusedRepos(8).reverse();
    const banners = staleBanners({ ...line, repos }, CLOCK);
    expect(banners).toHaveLength(1);
    expect(banners[0]?.title).toBe(
      "8 repositories have not been read since 16:10: Rate limit holds them until 17:00.",
    );
    expect(
      banners[0]?.repositories?.map(({ name, lastRead }) => [name, lastRead]),
    ).toEqual(repos.map((repo) => [repo.slug, repo.readAt.slice(11, 16)]));
    expect(banners[0]?.repositories?.[0]?.detail).toContain(
      "last reading for repository 7",
    );
  });

  it("gives each cause its own banner and a repository held busy its own", () => {
    const partial = lineOf("partial");
    const busy = partial.repos.find(
      (repo) => repo.slug === "example-org/mobile",
    );
    assert(busy);
    const repos = [...refusedRepos(3), ...refusedRepos(2, 3, "two"), busy];
    expect(
      staleBanners({ ...partial, repos }, CLOCK).map(
        (banner) => banner.repositories?.length,
      ),
    ).toEqual([3, 2, undefined]);
  });

  it("words a shared failure other than a rate limit by its step, and keeps steps apart", () => {
    const refusedAt = (step: "lookup" | "configuration") => ({
      step,
      failure: { class: "unauthorized" as const, account: "one" },
    });
    const repos = refusedRepos(3).map((repo, index) => ({
      ...repo,
      refusal: refusedAt(index < 2 ? "lookup" : "configuration"),
    }));
    const banners = staleBanners({ ...line, repos }, CLOCK);
    expect(banners.map((b) => b.title)).toEqual([
      "2 repositories have not been read since 16:10: Repository lookup failed (credential refused).",
      "example-org/repo-2: Dispatch section unreadable (credential refused); showing 16:12 data.",
    ]);
  });

  it("keeps one banner per repository on a line written before refusals kept their cause", () => {
    const partial = lineOf("partial");
    const legacy = refusedRepos(5).map(
      ({ refusal: _refusal, ...repo }) => repo,
    );
    const banners = staleBanners({ ...partial, repos: legacy }, CLOCK);
    expect(banners).toHaveLength(5);
    expect(banners.every((b) => b.repositories === undefined)).toBe(true);
  });

  /** The partial line with example-org/mobile refused at its newest tick, as `refused` and `refusal` say. */
  const refusedMobile = (refused: string, refusal: unknown): LineSnapshot => {
    const partial = lineOf("partial");
    return {
      ...partial,
      repos: partial.repos.map((r) =>
        r.slug === "example-org/mobile"
          ? {
              ...r,
              slug: null,
              lastSlug: r.slug,
              refused,
              ...(refusal === undefined
                ? {}
                : { refusal: refusal as LineRefusal }),
            }
          : r,
      ),
    };
  };

  it("leads a repository the dispatcher's quota share paused with one short line, its detail only on expanding", () => {
    const refusal =
      "the repository lookup waits for the rate limit: gh repo view exited 1: GitHub's rate limit for this credential is spent until 2026-11-03T17:30:00.000Z: the dispatcher's share (50%) of the complexity window is spent; 2400 of 5000 are left to passes and people (dispatcher); nothing was sent; the last reading, of 2026-11-03T16:05:00.000Z (42m old): 1 open pull request(s)";
    const line = refusedMobile(refusal, {
      step: "lookup",
      failure: {
        class: "rate-limited",
        until: "2026-11-03T17:30:00.000Z",
        quota: { system: "GitHub", share: true },
      },
    });
    const [banner] = staleBanners(line, CLOCK);
    expect(banner).toEqual({
      key: "/srv/work/mobile",
      title:
        "example-org/mobile: GitHub quota paused until 17:30, dispatcher's share spent; showing 16:05 data.",
      body: "Its needs, queue and sessions below are as of the 16:05 tick, 42 min ago.",
      detail: `The newest tick that tried could not read it: ${refusal}`,
    });
    // The line names neither the failed command, the window's numbers nor the kept reading.
    for (const shown of [banner?.title, banner?.body])
      for (const detail of [
        "gh repo view",
        "left to passes and people",
        "the last reading",
        "cannot say which repository",
      ])
        expect(shown).not.toContain(detail);
  });

  it("gives any other refusal the same shape: what stopped the read in a few words, the rest on expanding", () => {
    const refusal =
      "the forge cannot say which repository this is: gh repo view exited 1: HTTP 401: Bad credentials";
    const line = refusedMobile(refusal, {
      step: "lookup",
      failure: { class: "unauthorized" },
    });
    expect(staleBanners(line, CLOCK)[0]).toMatchObject({
      title:
        "example-org/mobile: Repository lookup failed (credential refused); showing 16:05 data.",
      detail: `The newest tick that tried could not read it: ${refusal}`,
    });
    const own = refusedMobile("GitHub limited it", {
      step: "configuration",
      failure: { class: "rate-limited", until: "2026-11-03T17:30:00.000Z" },
    });
    expect(staleBanners(own, CLOCK)[0]?.title).toBe(
      "example-org/mobile: Rate limit holds it until 17:30; showing 16:05 data.",
    );
  });

  it("shows the whole sentence for a refusal written without its parts, or with a step this page does not know", () => {
    const refusal = "the forge cannot say which repository this is";
    const whole = {
      key: "/srv/work/mobile",
      title: "example-org/mobile has not been read since 16:05, 42 min ago.",
      body: `The newest tick that tried could not read it (${refusal}). Its needs, queue and sessions below are as of the 16:05 tick.`,
    };
    expect(staleBanners(refusedMobile(refusal, undefined), CLOCK)).toEqual([
      whole,
    ]);
    expect(
      staleBanners(refusedMobile(refusal, { step: "a-later-step" }), CLOCK),
    ).toEqual([whole]);
  });

  it("says when the server is not answering, and alarms", () => {
    expect(freshOf(line, CLOCK, true).detail).toContain(
      "The next tick is due 16:50.",
    );
    expect(freshOf(line, CLOCK, true)).toMatchObject({
      short: "Updated 2 min ago · offline",
      alarm: true,
    });
  });

  it("has no tick to name before the first", () => {
    expect(freshOf(null, CLOCK, false)).toMatchObject({
      short: "No tick yet",
      alarm: false,
    });
  });

  it("names the tick in the host's zone", () => {
    expect(
      freshOf(line, { ...CLOCK, timeZone: "Asia/Tokyo" }, false).detail[0],
    ).toBe(
      "The running, needs-you and queue panels show what the 01:45 tick found, host time; the log is read on its own.",
    );
  });
});

const ACCOUNT: LineAccount = {
  name: "work-a",
  vendor: "claude",
  cap: 2,
  held: 0,
  wall: null,
  wallUnrecorded: false,
  notAdmitted: null,
};

describe("an account", () => {
  it("shows local weights and keeps legacy snapshots readable", () => {
    expect(accountView(ACCOUNT, CLOCK).weightText).toContain("weight 100");
    const paused = accountView(
      {
        ...ACCOUNT,
        weight: { configured: 0, effective: 0, reason: "host-local pause" },
      },
      CLOCK,
    );
    expect(paused.weightText).toContain("weight 0, effective 0");
    expect(paused.free).toBe(false);
    expect(paused.state).toBe("not admitted");
    const invalid = accountView(
      {
        ...ACCOUNT,
        weight: {
          configured: null,
          effective: 0,
          reason: "accounts section does not read",
        },
      },
      CLOCK,
    );
    expect(invalid.weightText).toContain("weight unreadable, effective 0");
    expect(invalid.free).toBe(false);
  });
  it("restores the configured weight when a snapshot's wall has expired", () => {
    const account = {
      ...ACCOUNT,
      weight: {
        configured: 25,
        effective: 0,
        reason: "walled until 2026-11-03T16:10:00.000Z; local file",
      },
    };
    expect(
      accountView(
        { ...account, wall: { resetAt: iso(18, 27), source: "test" } },
        CLOCK,
      ).weightText,
    ).toContain("weight 25, effective 0");
    expect(
      accountView(
        { ...account, wall: { resetAt: iso(16, 10), source: "test" } },
        CLOCK,
      ).weightText,
    ).toBe("weight 25, effective 25; local file");
  });
  it("shows how full it is", () => {
    const view = accountView({ ...ACCOUNT, held: 1 }, CLOCK);
    expect(view.heldText).toBe("1 of 2");
    expect(view.pips).toEqual([true, false]);
    expect(view.state).toBeNull();
    expect(view.free).toBe(true);
  });

  it("is at cap when every slot is held", () => {
    const view = accountView({ ...ACCOUNT, held: 2 }, CLOCK);
    expect(view.state).toBe("at cap");
    expect(view.free).toBe(false);
  });

  it("says when a wall lifts", () => {
    const view = accountView(
      { ...ACCOUNT, wall: { resetAt: iso(18, 27), source: "the backoff" } },
      CLOCK,
    );
    expect(view.state).toBe("behind a wall");
    expect(view.wall).toBe("lifts 18:27, in 1 h 40 min");
    expect(view.free).toBe(false);
  });

  it("does not count a wall whose reset has passed", () => {
    const view = accountView(
      { ...ACCOUNT, wall: { resetAt: iso(16, 10), source: "the backoff" } },
      CLOCK,
    );
    expect(view.state).toBeNull();
    expect(view.wall).toBeNull();
    expect(view.free).toBe(true);
  });

  it("is not free behind a wall no record holds, or when no drive is admitted", () => {
    const unrecorded = accountView({ ...ACCOUNT, wallUnrecorded: true }, CLOCK);
    expect(unrecorded.free).toBe(false);
    expect(unrecorded.state).toBe("wall not recorded");
    const refused = accountView(
      { ...ACCOUNT, notAdmitted: "its vendor runs no drive" },
      CLOCK,
    );
    expect(refused.free).toBe(false);
    expect(refused.wall).toBe("its vendor runs no drive");
  });

  it("summarizes the slots and walls", () => {
    expect(
      slotSummary(
        [
          { ...ACCOUNT, held: 1 },
          {
            ...ACCOUNT,
            name: "work-b",
            wall: { resetAt: iso(18, 27), source: "the backoff" },
          },
        ],
        NOW,
      ),
    ).toBe("1 of 4 slots held, 1 wall");
  });
});

describe("the next free account", () => {
  const accounts = ["work-a", "work-b", "work-c"].map((name) => ({
    ...ACCOUNT,
    name,
  }));

  it("rotates on from the last launch's", () => {
    expect(
      nextFreeAccount({ ...LINE, accounts, lastAccount: "work-a" }, CLOCK),
    ).toBe("work-b");
    expect(
      nextFreeAccount({ ...LINE, accounts, lastAccount: "work-c" }, CLOCK),
    ).toBe("work-a");
  });

  it("starts at the first before any launch", () => {
    expect(
      nextFreeAccount({ ...LINE, accounts, lastAccount: null }, CLOCK),
    ).toBe("work-a");
  });

  it("skips what is not free", () => {
    const [first, second, third] = accounts;
    expect(
      nextFreeAccount(
        {
          ...LINE,
          accounts: [
            first as LineAccount,
            { ...(second as LineAccount), held: 2 },
            third as LineAccount,
          ],
          lastAccount: "work-a",
        },
        CLOCK,
      ),
    ).toBe("work-c");
  });

  it("is none when nothing is free", () => {
    expect(
      nextFreeAccount(
        {
          ...LINE,
          accounts: accounts.map((a) => ({ ...a, held: 2 })),
          lastAccount: "work-a",
        },
        CLOCK,
      ),
    ).toBeNull();
  });
});

describe("a repository", () => {
  const REPO: LineRepo = {
    slug: "example-org/web",
    path: "/srv/work/web",
    stages: ["rearm", "notify"],
    refused: null,
    failedReads: [],
    notes: [],
  };

  it("has a problem when refused or a read failed, not for a note", () => {
    expect(repoSummary([REPO])).toBe("1 repository");
    expect(
      repoSummary([{ ...REPO, notes: ["this repository has no pickups"] }]),
    ).toBe("1 repository");
    expect(repoSummary([REPO, { ...REPO, refused: "no such path" }])).toBe(
      "2 repositories, 1 with a read or setup problem",
    );
    expect(
      repoSummary([
        {
          ...REPO,
          failedReads: [{ record: "tracker", source: "s", detail: "d" }],
        },
      ]),
    ).toBe("1 repository, 1 with a read or setup problem");
  });

  it("lists its stages, then its details", () => {
    expect(
      repoRow({
        ...REPO,
        failedReads: [
          {
            record: "tracker",
            source: "s",
            detail: "The tracker cannot be opened",
          },
        ],
        notes: ["this repository has no pickups"],
      }).note,
    ).toBe(
      "rearm, notify. The tracker cannot be opened. this repository has no pickups",
    );
  });

  it("names itself by its path when the forge could not say", () => {
    expect(repoRow({ ...REPO, slug: null }).slug).toBe("/srv/work/web");
  });
});
