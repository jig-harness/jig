/**
 * The scenarios the dashboard is checked against, as what the server would read:
 * the line a tick wrote and the outcome log. The data is neutral and fixed in
 * UTC on 2026-11-03, with the server's clock held at 16:47:30.
 */
import type {
  LineNeed,
  LineQueued,
  LineSession,
  LineSnapshot,
} from "../plugin/dispatch/lib/dashboard-contract.ts";
import type { LogRow } from "../plugin/dispatch/lib/log.ts";
import {
  busyLoad,
  drive,
  framedDecision,
  line,
  need,
  queued,
} from "./fixture-line.ts";
import { picksNeeds } from "./fixture-picks.ts";
import { mergingReady, waitingReady } from "./fixture-ready.ts";
import {
  API,
  ended,
  generated,
  INF,
  iso,
  loudRows,
  MOB,
  nightly,
  NOW_MS,
  observed,
  resetRecords,
  T,
  WEB,
} from "./fixture-rows.ts";

export const SCENARIOS = [
  "quiet",
  "loud",
  "merge",
  "hung",
  "queue",
  "stopped",
  "gone",
  "token",
  "empty",
  "long",
  "picks",
  "partial",
] as const;
export type ScenarioId = (typeof SCENARIOS)[number];

export interface Fixture {
  now: string;
  line: LineSnapshot | null;
  rows: LogRow[];
}

function workingTwo(): LineSession[] {
  return [
    drive({
      account: "work-a",
      repo: API,
      pr: 1207,
      title: "Retry the webhook on a 5xx",
      created: T(15, 30),
      round: 3,
      threads: [9, 7, 5],
      heartbeat: 6,
    }),
    drive({
      account: "codex-a",
      vendor: "codex",
      repo: INF,
      pr: 93,
      title: "Pin the mobile build image",
      created: T(16, 5),
      round: 2,
      threads: [4, 2],
      heartbeat: 3,
    }),
  ];
}

function loudNeeds(): LineNeed[] {
  return [
    need({
      cause: "parked",
      stage: "rearm",
      repo: WEB,
      pr: 456,
      title: "Retry the webhook on a 5xx",
      since: T(7, 5),
      reason:
        "drive ledger parked: stopped 8 (parked), waiting on thread PRRT_x1, thread PRRT_x2: a person answers",
      decisions: [
        framedDecision(
          "PRRT_x1",
          "scope",
          "Should the retry cover 4xx responses too?",
          [
            "- **A: retry 5xx only** what the issue asks. Changes: the retry helper. Costs: leaves 429 unhandled.",
            "- **B: retry 5xx and 429** Changes: one more test. Costs: needs a backoff cap.",
          ],
          "**A: retry 5xx only**, because 429 is rate limiting and wants its own issue",
          "A",
          "The 5xx retry is implemented and its test passes.",
          "maintainer-a",
        ),
      ],
      notified: T(7, 10),
    }),
    need({
      cause: "parked",
      stage: "rearm",
      repo: API,
      pr: 1210,
      title: "Split the invoice table migration",
      since: T(9, 40),
      reason:
        "drive ledger parked: stopped 8 (parked), waiting on finding PRRT_x7: a person answers",
      decisions: [
        {
          ...framedDecision(
            "PRRT_x7",
            "destructive",
            "Drop the old invoice column in this pull request?",
            [
              "- **A: drop it here** Changes: one migration. Costs: cannot be rolled back after deploy.",
              "- **B: drop it in a later release** Changes: two migrations. Costs: the column stays for a release.",
            ],
            "**B: drop it in a later release**, because a rollback stays possible",
            "B",
            "The table split is migrated and its tests pass.",
            "maintainer-b",
          ),
          kind: "finding",
        },
      ],
      notified: T(9, 45),
    }),
    need({
      cause: "parked",
      stage: "rearm",
      repo: WEB,
      pr: 475,
      title: "Move the release notes to the docs site",
      since: T(11, 15),
      reason:
        "drive ledger parked: stopped 8 (parked), waiting on thread PRRT_x1, thread PRRT_x2: a person answers",
      decisions: [
        {
          key: "PRRT_x2",
          kind: "thread",
          lines: [],
          question: null,
          recommendation: null,
          decisionClass: "scope",
        },
      ],
      notified: T(11, 20),
    }),
    need({
      cause: "parked",
      stage: "rearm",
      repo: INF,
      pr: 95,
      title: "Raise the runner disk quota",
      since: T(13, 30),
      reason:
        "drive ledger parked: stopped 8 (parked), waiting on thread PRRT_x4: a person answers",
      decisions: [
        {
          key: "PRRT_x4",
          kind: "thread",
          lines: [],
          question: null,
          recommendation: null,
          decisionClass: "scope",
        },
      ],
      notified: T(13, 35),
    }),
    need({
      cause: "needs-person",
      stage: "rearm",
      repo: WEB,
      pr: 479,
      title: "Cache the session lookup",
      since: T(10, 50),
      reason:
        "drive ledger needs-person: stopped 14: only a person settles it (see the drive’s handoff)",
      notified: T(10, 55),
    }),
    need({
      cause: "stalled",
      stage: "pickup",
      repo: API,
      item: "API-77",
      url: "https://tracker.example/API-77",
      title: "Add the audit export",
      since: T(12, 25),
      reason: "a claimed item with no running session past stalled_after",
      notified: T(12, 30),
    }),
    need({
      cause: "double-claim",
      stage: "pickup",
      repo: WEB,
      item: "WEB-418",
      url: null,
      title: "Fix the login redirect",
      since: T(15, 20),
      reason: "WEB-418 joins to 2 running sessions",
      notified: T(15, 25),
      workspaces: ["/srv/work/web/web-418", "/srv/work/web/web-418-b"],
    }),
    need({
      cause: "followup-failed",
      stage: "followup",
      repo: WEB,
      pr: 461,
      title: "Trim the checkout bundle",
      since: T(14, 2),
      reason:
        "a follow-up claimed it 17h ago (comment 456) and has not marked it done",
      notified: T(14, 5),
    }),
  ];
}

const NOT_BOUND: LineQueued["launch"] = {
  outcome: "reported",
  detail:
    "A pickup does not start on today’s runtime: an Orca agent launch cannot bind its session to a chosen account yet. Waiting for a tick will not start these.",
};

const STALE_BILLING = queued({
  source: "re-armable",
  group: "starts",
  repo: API,
  pr: 1209,
  title: "Drop the unused billing flag",
  why: "drive ledger stale: stopped 0 (converged), and now conflicting with its base: re-drive on any account",
  stale: true,
});

const LABELLED_WHY = "a person added the drive label";

function loudSessions(): LineSession[] {
  return [
    drive({
      account: "work-a",
      repo: API,
      pr: 1207,
      title: "Retry the webhook on a 5xx",
      created: T(15, 30),
      round: 3,
      threads: [9, 7, 5],
      heartbeat: 6,
    }),
    drive({
      account: "work-a",
      repo: WEB,
      pr: 468,
      title: "Split the invoice table migration",
      created: T(16, 0),
      round: 1,
      threads: [11],
      heartbeat: 4,
    }),
    drive({
      account: "work-b",
      repo: INF,
      pr: 94,
      title: "Pin the mobile build image",
      created: T(14, 45),
      round: 5,
      threads: [8, 6, 5, 3, 2],
      heartbeat: 12,
    }),
    drive({
      account: "work-b",
      repo: API,
      pr: 1219,
      title: "Rotate the signing key",
      created: T(16, 45),
      launch: "pending",
      round: 0,
      passMinutes: null,
    }),
  ];
}

function loudQueue(): LineQueued[] {
  return [
    STALE_BILLING,
    queued({
      source: "label drive",
      group: "starts",
      repo: WEB,
      pr: 480,
      title: "Add the health endpoint",
      why: LABELLED_WHY,
    }),
    queued({
      source: "held",
      group: "held",
      repo: API,
      pr: 1214,
      title: "Add the invoice index",
      why: "held: serialized behind #1203 in migrations",
      hold: { leader: 1203, area: "migrations", waited: 75 },
    }),
    queued({
      source: "assigned",
      group: "reported",
      repo: WEB,
      item: "WEB-412",
      url: "https://tracker.example/WEB-412",
      title: "Paginate the audit list",
      why: "assigned by maintainer-a",
      assignedBy: "maintainer-a",
      launch: NOT_BOUND,
    }),
  ];
}

function hungFixture(): Fixture {
  const sessions = [
    drive({
      account: "work-a",
      repo: API,
      pr: 1211,
      title: "Rotate the signing key",
      created: T(15, 40),
      agent: { state: "blocked", since: iso(T(16, 21)) },
      round: 2,
      threads: [6, 4],
      heartbeat: 26,
      waiting: "blocked past blocked_after",
    }),
    drive({
      account: "work-b",
      repo: API,
      pr: 1215,
      stage: "takeover",
      title: "Add the invoice index",
      created: T(16, 20),
      round: 4,
      threads: [7, 6, 5, 4],
      heartbeat: 7,
      replaces: "20261103T151002Z-ef44ab90",
    }),
    drive({
      account: "work-c",
      repo: WEB,
      pr: 472,
      title: "Trim the checkout bundle",
      created: T(14, 50),
      agent: { state: "waiting", since: iso(T(15, 22)) },
      round: 3,
      threads: [5, 4, 4],
      heartbeat: 85,
      episode: {
        observedAt: iso(T(15, 22)),
        resetAt: iso(T(16, 10)),
        evidence: "usage limit reached, resets at 16:10",
        last: true,
      },
      nudge: { at: iso(T(16, 15)), delivery: "sent", detail: "continue" },
    }),
    drive({
      account: "codex-a",
      vendor: "codex",
      repo: INF,
      pr: 94,
      title: "Pin the mobile build image",
      created: T(13, 30),
      round: 8,
      threads: [6, 6, 6, 6],
      heartbeat: 9,
      drifting: "threads fall within drive_rounds_flat (3)",
    }),
    drive({
      account: "codex-b",
      vendor: "codex",
      repo: WEB,
      pr: 460,
      title: "Cache the session lookup",
      created: T(11, 10),
      launch: "unknown",
      launchReason: "a claim from another boot",
      round: 2,
      threads: [3, 3],
      passMinutes: null,
    }),
  ];
  return {
    now: new Date(NOW_MS).toISOString(),
    line: line({
      sessions,
      walls: {
        "work-c": { resetAt: T(16, 10), source: "the drive’s record, PR #472" },
      },
      needs: [
        need({
          cause: "nudge-unanswered",
          stage: "steer",
          repo: WEB,
          pr: 472,
          title: "Trim the checkout bundle",
          since: T(16, 35),
          reason:
            "one nudge sent 16:15, wall reset passed 16:10, session still waiting at 16:35",
          notified: T(16, 35),
        }),
      ],
    }),
    rows: [
      ...nightly(),
      observed(
        T(16, 15),
        WEB,
        "steer",
        "PR #472",
        "nudge",
        null,
        "nudge sent: continue",
        "work-c",
      ),
      observed(
        T(15, 58),
        INF,
        "rearm",
        "PR #94",
        "drifting",
        null,
        "threads 6 6 6 6 over the last 3 recorded rounds",
        "codex-a",
      ),
      observed(
        T(15, 10),
        API,
        "rearm",
        "PR #1215",
        "takeover",
        "stalled",
        "taken over (exit 14)",
        "work-b",
      ),
    ],
  };
}

function queueFixture(): Fixture {
  return {
    now: new Date(NOW_MS).toISOString(),
    line: line({
      sessions: workingTwo(),
      lastAccount: "codex-a",
      needs: [
        need({
          cause: "assigner-cannot-write",
          stage: "pickup",
          repo: API,
          item: "#231",
          url: null,
          title: "Document the export format",
          since: T(13, 15),
          reason:
            "assigned by contractor-c, who cannot write to this repository: reported, never planned",
        }),
      ],
      queue: [
        STALE_BILLING,
        queued({
          source: "re-armable",
          group: "starts",
          repo: WEB,
          pr: 477,
          title: "Split the checkout steps",
          why: "stopped 16 (quota-parked); its wall has lifted",
        }),
        queued({
          source: "label drive",
          group: "starts",
          repo: INF,
          pr: 92,
          title: "Add the staging smoke test",
          why: LABELLED_WHY,
        }),
        queued({
          source: "held",
          group: "held",
          repo: API,
          pr: 1214,
          title: "Add the invoice index",
          why: "held: serialized behind #1203 in migrations",
          hold: { leader: 1203, area: "migrations", waited: 40 },
        }),
        queued({
          source: "held",
          group: "held",
          repo: API,
          pr: 1218,
          title: "Rename the ledger table",
          why: "held: serialized behind #1203 in migrations",
          hold: { leader: 1203, area: "migrations", waited: 180 },
        }),
        queued({
          source: "assigned",
          group: "reported",
          repo: WEB,
          item: "WEB-412",
          url: "https://tracker.example/WEB-412",
          title: "Paginate the audit list",
          why: "assigned by maintainer-a",
          assignedBy: "maintainer-a",
          launch: NOT_BOUND,
        }),
        queued({
          source: "assigned",
          group: "reported",
          repo: API,
          item: "API-77",
          url: null,
          title: "Add the audit export",
          why: "assigned by maintainer-b",
          assignedBy: "maintainer-b",
          launch: NOT_BOUND,
        }),
        queued({
          source: "assigned",
          group: "never",
          repo: API,
          item: "#231",
          url: null,
          title: "Document the export format",
          why: "assigned by contractor-c, who cannot write: never starts",
          assignedBy: "contractor-c",
        }),
      ],
    }),
    rows: nightly(),
  };
}

/** The mobile repository's checkout, which another tick holds busy in the partial scenario. */
const MOB_PATH = "/srv/work/mobile";

/**
 * A line kept current while one repository is busy: every tick since 16:05
 * found the mobile repository held by another tick, so its part is as of
 * then and the rest as of 16:45. Its items carry their links and titles as
 * the tracker listing gave them, one queued item and two log rows keep none.
 */
function partialFixture(): Fixture {
  const mobileRead = T(16, 5);
  const base = line({
    sessions: workingTwo(),
    lastAccount: "codex-a",
    needs: [
      need({
        cause: "stalled",
        stage: "pickup",
        repo: API,
        item: "#240",
        url: "https://forge.example/example-org/api/issues/240",
        title: "Retry the webhook delivery",
        since: T(15, 50),
        reason: "a claimed item with no running session past stalled_after",
        notified: T(15, 55),
      }),
    ],
    queue: [
      queued({
        source: "assigned",
        group: "never",
        repo: API,
        item: "API-80",
        url: "https://tracker.example/acme/issue/API-80/backfill-the-ledger",
        title: "Backfill the ledger",
        why: "the child cannot be read completely",
      }),
      queued({
        source: "assigned",
        group: "reported",
        repo: API,
        item: "API-93",
        url: null,
        title: "Archive the old exports",
        why: "assigned by maintainer-b",
        assignedBy: "maintainer-b",
      }),
      queued({
        source: "held",
        group: "held",
        repo: MOB,
        pr: 61,
        title: "Bump the build tools",
        why: "held: serialized behind #60 in toolchain",
        hold: { leader: 60, area: "toolchain", waited: 50 },
      }),
    ],
  });
  return {
    now: new Date(NOW_MS).toISOString(),
    line: {
      ...base,
      repos: base.repos.map((r) => ({
        ...r,
        readAt: r.slug === MOB ? iso(mobileRead) : base.startedAt,
      })),
      ticks: (base.ticks ?? []).map((t) =>
        Date.parse(t.startedAt) > Date.parse(iso(mobileRead))
          ? {
              ...t,
              busy: [...new Set([...t.busy, MOB_PATH])],
              repos: t.repos.filter((r) => r.repo !== MOB),
            }
          : t,
      ),
    },
    rows: [
      {
        ...ended(
          T(14, 10),
          API,
          "pickup",
          "API-77",
          "work-a",
          "converged",
          "result done",
          38,
          null,
        ),
        title: "Add the audit export",
        url: "https://tracker.example/acme/issue/API-77/add-the-audit-export",
      },
      ended(
        T(13, 20),
        API,
        "pickup",
        "API-91",
        "work-b",
        "died",
        "no result recorded; its session exited 1",
        12,
        null,
      ),
    ],
  };
}

/** One scenario, as the server would read it. */
export function fixture(id: ScenarioId): Fixture {
  resetRecords();
  const now = new Date(NOW_MS).toISOString();
  const quietWall = {
    "work-b": { resetAt: T(18, 27), source: "the drive’s record, PR #92" },
  };
  switch (id) {
    case "quiet":
      return {
        now,
        line: line({
          sessions: workingTwo(),
          walls: quietWall,
          lastAccount: "codex-a",
        }),
        rows: nightly(),
      };
    case "loud":
      return {
        now,
        line: line({
          sessions: loudSessions(),
          needs: loudNeeds(),
          queue: loudQueue(),
          ready: waitingReady(),
          load: busyLoad(),
        }),
        rows: loudRows(),
      };
    case "merge":
      return {
        now,
        line: line({
          sessions: loudSessions(),
          needs: loudNeeds(),
          queue: loudQueue(),
          ready: mergingReady(),
          load: busyLoad(),
        }),
        rows: loudRows(),
      };
    case "hung":
      return hungFixture();
    case "queue":
      return queueFixture();
    case "stopped":
      return {
        now,
        line: line({
          tick: T(16, 0),
          sessions: workingTwo(),
          walls: quietWall,
          lastAccount: "codex-a",
        }),
        rows: nightly(),
      };
    case "gone":
      // The tick is the 16:40 one and still within its tolerance when the page loads, so what turns the page is the server stopping.
      return {
        now,
        line: line({
          tick: T(16, 40),
          sessions: loudSessions(),
          needs: loudNeeds(),
          queue: loudQueue(),
          ready: waitingReady(),
          longestTickMs: 3 * 60_000,
        }),
        rows: loudRows(),
      };
    case "token":
      return { now, line: line({}), rows: [] };
    case "empty":
      return { now, line: null, rows: [] };
    case "picks":
      return {
        now,
        line: line({
          sessions: workingTwo(),
          needs: picksNeeds(),
          lastAccount: "codex-a",
        }),
        rows: nightly(),
      };
    case "long":
      return {
        now,
        line: line({ sessions: workingTwo(), lastAccount: "codex-a" }),
        rows: generated(),
      };
    case "partial":
      return partialFixture();
  }
}
