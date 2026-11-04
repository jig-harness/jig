/**
 * The fixtures' line: how a scenario states the accounts, sessions, needs and
 * queue a tick would have written.
 */
import type {
  LineAccount,
  LineDecision,
  LineNeed,
  LineQueued,
  LineRepo,
  LineSession,
  LineSnapshot,
} from "../plugin/dispatch/lib/dashboard-contract.ts";
import { API, DOC, INF, iso, MOB, pad, prUrl, T, WEB } from "./fixture-rows.ts";

const INTERVAL_MS = 5 * 60_000;
const LONGEST_TICK_MS = 2 * 60_000;
const TICK_TOOK_MS = 63_000;
const BASE = Date.UTC(2026, 10, 3);

const REPOS: LineRepo[] = [
  {
    slug: WEB,
    path: "/srv/work/web",
    stages: ["rearm", "pickup", "followup", "notify", "steer"],
    refused: null,
    failedReads: [],
    notes: [],
  },
  {
    slug: API,
    path: "/srv/work/api",
    stages: ["rearm", "pickup", "followup", "notify", "steer"],
    refused: null,
    failedReads: [],
    notes: [],
  },
  {
    slug: MOB,
    path: "/srv/work/mobile",
    stages: ["rearm", "notify"],
    refused: null,
    failedReads: [
      {
        record: "tracker",
        source: ".config/jig.yaml",
        detail:
          "The tracker cannot be opened: issue_tracker.team is set but issue_tracker.adapter is not",
      },
    ],
    notes: [],
  },
  {
    slug: DOC,
    path: "/srv/work/docs",
    stages: ["rearm", "notify"],
    refused: null,
    failedReads: [
      {
        record: "identity",
        source: ".config/jig.yaml",
        detail: "No dispatch.identity: this repository has no pickups",
      },
    ],
    notes: [],
  },
  {
    slug: INF,
    path: "/srv/work/infra",
    stages: ["rearm", "pickup", "followup", "notify", "steer"],
    refused: null,
    failedReads: [],
    notes: [],
  },
];

function accounts(
  sessions: LineSession[],
  walls: Record<string, { resetAt: number; source: string }> = {},
): LineAccount[] {
  const list: Array<[string, string]> = [
    ["work-a", "claude"],
    ["work-b", "claude"],
    ["work-c", "claude"],
    ["codex-a", "codex"],
    ["codex-b", "codex"],
  ];
  return list.map(([name, vendor]) => {
    const wall = walls[name];
    return {
      name,
      vendor,
      cap: 2,
      held: sessions.filter((s) => s.account === name).length,
      wall:
        wall === undefined
          ? null
          : { resetAt: iso(wall.resetAt), source: wall.source },
      wallUnrecorded: false,
      notAdmitted: null,
    };
  });
}

/** What a scenario says of a drive; what it leaves out takes the plain default. */
interface DriveFixture {
  account: string;
  vendor?: string;
  repo: string;
  pr: number;
  title: string;
  created: number;
  stage?: LineSession["stage"];
  launch?: LineSession["launch"];
  launchReason?: string;
  agent?: LineSession["agent"];
  round?: number | null;
  threads?: number[];
  heartbeat?: number;
  passMinutes?: number | null;
  replaces?: string;
  episode?: LineSession["episode"];
  nudge?: LineSession["nudge"];
  drifting?: string;
  waiting?: string;
}

/** The records a scenario leaves out, as the line holds them: none. */
function unrecorded(o: DriveFixture) {
  return {
    launchReason: o.launchReason ?? null,
    agent: o.agent ?? null,
    replaces: o.replaces ?? null,
    episode: o.episode ?? null,
    nudge: o.nudge ?? null,
    drifting: o.drifting ?? null,
    waiting: o.waiting ?? null,
  };
}

/** The thread counts a drive's ledger recorded, one per round, ending at its round. */
function samplesOf(
  created: number,
  round: number | null,
  threads: number[],
): LineSession["samples"] {
  const firstRound = (round ?? threads.length) - threads.length + 1;
  return threads.map((count, i) => ({
    round: firstRound + i,
    threads: count,
    at: iso(created + (i + 1) * 15),
  }));
}

/** A pass deadline of 45 minutes unless the scenario names another, or none recorded. */
function passTimeoutOf(minutes: number | null | undefined): number | null {
  if (minutes === undefined) return 45 * 60;
  return minutes === null ? null : minutes * 60;
}

export function drive(o: DriveFixture): LineSession {
  const created = o.created;
  const round = o.round ?? null;
  return {
    record: `20261103T${pad(Math.floor(created / 60))}${pad(created % 60)}02Z-ef${10 + (o.pr % 89)}ab90`,
    account: o.account,
    vendor: o.vendor ?? "claude",
    repo: o.repo,
    stage: o.stage ?? "rearm",
    target: `PR #${o.pr}`,
    pr: o.pr,
    item: null,
    url: prUrl(o.repo, o.pr),
    title: o.title,
    createdAt: iso(created),
    launch: o.launch ?? "alive",
    round,
    samples: samplesOf(created, round, o.threads ?? []),
    heartbeat: o.heartbeat === undefined ? null : iso(T(16, 47) - o.heartbeat),
    passTimeoutSec: passTimeoutOf(o.passMinutes),
    workspace: `/srv/work/${o.repo.split("/")[1]}/pr-${o.pr}`,
    ...unrecorded(o),
  };
}

/** A decision as a drive records it: Markdown under the headings of its record. */
export function framedDecision(
  key: string,
  decisionClass: string,
  question: string,
  options: string[],
  recommendation: string,
  answer: string,
  done: string,
): LineDecision {
  return {
    key,
    kind: "thread",
    lines: [
      "## Question",
      question,
      "",
      "## Options",
      ...options,
      "",
      "## Recommended",
      recommendation,
      "",
      "## Class",
      decisionClass,
      "",
      "## Steps for a person",
      `Comment \`answer ${key}: ${answer}\` on the pull request.`,
      "",
      "## Already done",
      done,
    ],
    question,
    recommendation,
    decisionClass,
  };
}

export function need(o: {
  cause: LineNeed["cause"];
  stage: LineNeed["stage"];
  repo: string;
  pr?: number;
  item?: string;
  url?: string | null;
  title: string;
  since: number;
  reason: string;
  decisions?: LineDecision[];
  notified?: number;
  workspaces?: string[];
}): LineNeed {
  const pr = o.pr ?? null;
  return {
    cause: o.cause,
    stage: o.stage,
    repo: o.repo,
    target: pr === null ? (o.item ?? "") : `PR #${pr}`,
    pr,
    item: o.item ?? null,
    url: pr === null ? (o.url ?? null) : prUrl(o.repo, pr),
    title: o.title,
    since: iso(o.since),
    reason: o.reason,
    decisions: o.decisions ?? [],
    notified:
      o.notified === undefined
        ? null
        : { at: iso(o.notified), outcome: "sent", workspace: null },
    workspaces: o.workspaces ?? [],
  };
}

export function queued(o: {
  source: LineQueued["source"];
  group: LineQueued["group"];
  repo: string;
  pr?: number;
  item?: string;
  url?: string | null;
  title: string;
  why: string;
  stale?: boolean;
  assignedBy?: string;
  hold?: { leader: number; area: string; waited: number };
  launch?: LineQueued["launch"];
}): LineQueued {
  const pr = o.pr ?? null;
  return {
    source: o.source,
    group: o.group,
    repo: o.repo,
    target: pr === null ? (o.item ?? "") : `PR #${pr}`,
    pr,
    item: o.item ?? null,
    url: pr === null ? (o.url ?? null) : prUrl(o.repo, pr),
    title: o.title,
    why: o.why,
    stale: o.stale ?? false,
    assignedBy: o.assignedBy ?? null,
    hold:
      o.hold === undefined
        ? null
        : {
            leader: o.hold.leader,
            area: o.hold.area,
            since: iso(T(16, 47) - o.hold.waited),
          },
    launch: o.launch ?? null,
  };
}

export function line(o: {
  tick?: number;
  sessions?: LineSession[];
  walls?: Record<string, { resetAt: number; source: string }>;
  needs?: LineNeed[];
  queue?: LineQueued[];
  lastAccount?: string;
  longestTickMs?: number;
}): LineSnapshot {
  const tick = o.tick ?? T(16, 45);
  const sessions = o.sessions ?? [];
  return {
    version: 1,
    runId: `20261103T${pad(Math.floor(tick / 60))}${pad(tick % 60)}00Z`,
    startedAt: iso(tick),
    finishedAt: new Date(BASE + tick * 60_000 + TICK_TOOK_MS).toISOString(),
    exitStatus: 0,
    apply: true,
    applyWithheld: null,
    intervalMs: INTERVAL_MS,
    longestTickMs: o.longestTickMs ?? LONGEST_TICK_MS,
    plugin: "0.127.1",
    accounts: accounts(sessions, o.walls),
    lastAccount: o.lastAccount ?? "work-a",
    sessions,
    needs: o.needs ?? [],
    queue: o.queue ?? [],
    repos: REPOS,
  };
}
