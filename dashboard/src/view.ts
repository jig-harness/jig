/**
 * What the panels above the log show, as pure functions of the line the newest
 * tick wrote. Only what a record holds is stated; what is null is left out.
 */
import type {
  LineAccount,
  LineRepo,
  LineSession,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { ago, clock, plural, span, until } from "./format.ts";
import { noLinkText } from "./links.ts";
import { type Role, roleOf, stageMark } from "./status.ts";

/** The server's clock and the host's zone. */
export interface Clock {
  nowMs: number;
  timeZone: string;
}

/** One line of a fold's evidence; `copy` is what its Copy button takes. */
export interface EvidenceRow {
  k: string;
  v: string;
  copy?: string;
}

// ---------- staleness ----------

/** Whether the timer is past the interval plus its longest recent tick. */
export function isOverdue(line: LineSnapshot, nowMs: number): boolean {
  return (
    nowMs > Date.parse(line.startedAt) + line.intervalMs + line.longestTickMs
  );
}

/** How fresh what the page shows is: a few words for the strip, the facts for its hint. */
export interface FreshView {
  short: string;
  /** One sentence per fact, for the hint the strip's words open. */
  detail: string[];
  alarm: boolean;
}

/** How old the newest tick is, and what is known of the next. */
export function freshOf(
  line: LineSnapshot | null,
  clockNow: Clock,
  gone: boolean,
): FreshView {
  if (line === null)
    return gone
      ? {
          short: "Not read",
          detail: [
            "The server is not answering, and no tick was read before it stopped.",
          ],
          alarm: true,
        }
      : {
          short: "No tick yet",
          detail: ["No tick has written what it found on this host yet."],
          alarm: false,
        };
  const { nowMs, timeZone } = clockNow;
  const tick = Date.parse(line.startedAt);
  const due = tick + line.intervalMs;
  const shows = `The running, needs-you and queue panels show what the ${clock(tick, timeZone)} tick found, host time; the log is read on its own.`;
  const age = `Updated ${ago(tick, nowMs)} ago`;
  const next = `The next tick ${nowMs > due ? "was" : "is"} due ${clock(due, timeZone)}.`;
  if (gone)
    return {
      short: `${age} · offline`,
      detail: [
        shows,
        next,
        "The server is not answering, so nothing newer can be read.",
      ],
      alarm: true,
    };
  return isOverdue(line, nowMs)
    ? {
        short: `${age} · overdue`,
        detail: [
          shows,
          `The next tick was due ${clock(due, timeZone)}; it is ${ago(due, nowMs)} overdue.`,
        ],
        alarm: true,
      }
    : {
        short: age,
        detail: [shows, `The next tick is due ${clock(due, timeZone)}.`],
        alarm: false,
      };
}

/** The banner for a timer that has stopped ticking. */
export function timerBanner(
  line: LineSnapshot,
  clockNow: Clock,
): { title: string; body: string } {
  const { nowMs, timeZone } = clockNow;
  const tick = Date.parse(line.startedAt);
  return {
    title: `The timer has not ticked for ${ago(tick, nowMs)}.`,
    body: `Everything below is as of the ${clock(tick, timeZone)} tick; nothing here is newer. The dispatcher starts nothing until the timer runs, and this page cannot see why: look on the host.`,
  };
}

/**
 * A banner for each repository whose part of the line is past the timer's
 * next tick and its longest recent one while the line itself is current:
 * the ticks since ran, and none of them read it. Each names the repository,
 * when its part was read, and why the ticks since did not read it: another
 * tick held it busy, or they read other repositories.
 */
export function staleBanners(
  line: LineSnapshot,
  clockNow: Clock,
): Array<{ key: string; title: string; body: string }> {
  const { nowMs, timeZone } = clockNow;
  return line.repos.flatMap((repo) => {
    if (repo.readAt === undefined) return [];
    const read = Date.parse(repo.readAt);
    if (nowMs <= read + line.intervalMs + line.longestTickMs) return [];
    const name = repo.slug ?? repo.path;
    const since = (line.ticks ?? []).filter(
      (t) => Date.parse(t.startedAt) > read,
    );
    const busy = since.filter((t) => t.busy.includes(repo.path)).length;
    const why =
      busy === 0
        ? `None of the ${plural(since.length, "tick")} since read it.`
        : `Another tick held it busy on ${busy} of the ${plural(since.length, "tick")} since, so none of them read it.`;
    return [
      {
        key: repo.path,
        title: `${name} has not been read since ${clock(read, timeZone)}, ${ago(read, nowMs)} ago.`,
        body: `${why} Its needs, queue and sessions below are as of the ${clock(read, timeZone)} tick.`,
      },
    ];
  });
}

// ---------- sessions ----------

export type SessionKind =
  | "working"
  | "takeover"
  | "pending"
  | "stuck"
  | "waitWall"
  | "waitOther"
  | "drift"
  | "unknown";

/** The wall a session is on now: an episode that is still its last record. */
function currentWall(s: LineSession): LineSession["episode"] {
  return s.episode?.last === true ? s.episode : null;
}

function wallHasPassed(s: LineSession, nowMs: number): boolean {
  const reset = currentWall(s)?.resetAt ?? null;
  return reset !== null && Date.parse(reset) <= nowMs;
}

/** Which kind of fact a session's record states, first match in this order. */
export function sessionKind(s: LineSession, nowMs: number): SessionKind {
  if (s.launch === "unknown") return "unknown";
  if (s.launch === "pending") return s.stuck == null ? "pending" : "stuck";
  const state = s.agent?.state;
  if (state === "waiting" || state === "blocked" || s.waiting !== null)
    return wallHasPassed(s, nowMs) ? "waitWall" : "waitOther";
  if (s.drifting !== null) return "drift";
  return s.stage === "takeover" ? "takeover" : "working";
}

/** Whether a session belongs under "Not moving". */
export function isStuck(kind: SessionKind): boolean {
  return (
    kind === "waitWall" ||
    kind === "waitOther" ||
    kind === "drift" ||
    kind === "stuck" ||
    kind === "unknown"
  );
}

export interface SlotView {
  record: string;
  account: string;
  repo: string;
  target: string;
  title: string | null;
  url: string | null;
  /** What the card says when `url` is null: what is missing and where to look. */
  noLink: string | null;
  stage: string;
  mark: string;
  role: Role;
  fact: string;
  kind: SessionKind;
  evidence: EvidenceRow[];
}

function waitingFor(s: LineSession, nowMs: number): string {
  const word = s.agent?.state ?? "waiting";
  const since = s.agent?.since ?? null;
  return since === null ? word : `${word} ${ago(Date.parse(since), nowMs)}`;
}

function waitFact(s: LineSession, clockNow: Clock): string {
  const { nowMs, timeZone } = clockNow;
  const waited = waitingFor(s, nowMs);
  const wall = currentWall(s);
  const reset = wall?.resetAt ?? null;
  if (wall === null) return `${waited}, kind not reported`;
  if (reset === null) return `${waited}, wall reset unknown`;
  if (!wallHasPassed(s, nowMs))
    return `${waited}, wall lifts ${clock(Date.parse(reset), timeZone)}`;
  const nudge =
    s.nudge === null
      ? ""
      : `, nudge sent ${clock(Date.parse(s.nudge.at), timeZone)}`;
  return `${waited}, wall reset passed ${clock(Date.parse(reset), timeZone)}${nudge}`;
}

function waitEvidence(
  s: LineSession,
  clockNow: Clock,
  account: LineAccount | undefined,
): EvidenceRow[] {
  const { nowMs, timeZone } = clockNow;
  const wall = currentWall(s);
  if (wall === null)
    return [
      { k: "kind of wait", v: "not reported by the runtime" },
      {
        k: "behind a wall",
        v: account !== undefined && wallIsUp(account, nowMs) ? "yes" : "no",
      },
    ];
  const reset = wall.resetAt === null ? null : Date.parse(wall.resetAt);
  const rows: EvidenceRow[] = [
    { k: "kind of wait", v: "usage limit (waiting episode)" },
  ];
  if (reset !== null)
    rows.push({
      k: "wall reset",
      v:
        reset <= nowMs
          ? `${clock(reset, timeZone)}, ${ago(reset, nowMs)} ago`
          : `${clock(reset, timeZone)}, in ${until(reset, nowMs)}`,
    });
  if (s.nudge !== null)
    rows.push({
      k: "nudge",
      v: `${s.nudge.delivery} ${clock(Date.parse(s.nudge.at), timeZone)}, one per episode`,
    });
  return rows;
}

function driveEvidence(s: LineSession, nowMs: number): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  if (s.round !== null && s.samples.length > 0)
    rows.push({ k: "round", v: String(s.round) });
  if (s.samples.length > 0)
    rows.push({
      k: "threads by round",
      v: s.samples.map((x) => x.threads).join(" "),
    });
  if (s.heartbeat !== null)
    rows.push({
      k: "heartbeat",
      v: `${ago(Date.parse(s.heartbeat), nowMs)} old`,
    });
  if (s.passTimeoutSec !== null)
    rows.push({
      k: "pass deadline",
      v: s.passTimeoutSec === 0 ? "none" : span(s.passTimeoutSec / 60),
    });
  return rows;
}

function factOf(
  s: LineSession,
  kind: SessionKind,
  clockNow: Clock,
  tickMs: number,
): string {
  const { nowMs } = clockNow;
  const created = Date.parse(s.createdAt);
  const since = ago(created, nowMs);
  switch (kind) {
    case "unknown":
      return `launch record unknown, ${since}, holds its slot`;
    case "pending":
      return created >= tickMs
        ? "pending, launched this tick, not claimed yet"
        : "pending, not claimed yet";
    case "stuck":
      return `launch record stuck pending, ${since}, needs a person`;
    case "waitWall":
    case "waitOther":
      return waitFact(s, clockNow);
    case "drift": {
      const counts = s.samples.map((x) => x.threads);
      return counts.length < 2
        ? "drifting"
        : `drifting, threads flat ${counts.length - 1} rounds: ${counts.join(" ")}`;
    }
    case "takeover":
      return `working, took over a stalled driver ${since} ago`;
    case "working": {
      const word = s.agent?.state ?? "working";
      return s.round === null
        ? `${word}, ${since}`
        : `${word}, round ${s.round}, ${since}`;
    }
  }
}

function roleFor(s: LineSession, kind: SessionKind): Role {
  switch (kind) {
    case "unknown":
      return roleOf("launch record", "unknown");
    case "pending":
      return roleOf("launch record", "pending");
    case "stuck":
      return roleOf("launch record", "stuck");
    case "waitWall":
    case "waitOther":
      return roleOf("agent state", s.agent?.state ?? "waiting");
    case "drift":
      return roleOf("notify cause", "drifting");
    case "takeover":
    case "working":
      return roleOf("agent state", s.agent?.state ?? "working");
  }
}

function specificEvidence(
  s: LineSession,
  kind: SessionKind,
  clockNow: Clock,
  account: LineAccount | undefined,
): EvidenceRow[] {
  switch (kind) {
    case "unknown":
      return [
        ...(s.launchReason === null ? [] : [{ k: "why", v: s.launchReason }]),
        {
          k: "to release",
          v: "a person runs jig dispatch clear",
          copy: "jig dispatch clear",
        },
      ];
    case "stuck":
      return [
        ...(s.stuck == null ? [] : [{ k: "why", v: s.stuck }]),
        {
          k: "to release",
          v: "a person checks for a session it started, then runs jig dispatch clear",
          copy: `jig dispatch clear ${s.record}`,
        },
      ];
    case "waitWall":
    case "waitOther":
      return waitEvidence(s, clockNow, account);
    case "drift":
      return s.drifting === null ? [] : [{ k: "expectation", v: s.drifting }];
    case "takeover":
      return s.replaces === null
        ? []
        : [{ k: "replaces", v: s.replaces, copy: s.replaces }];
    default:
      return [];
  }
}

/** A session as a slot box shows it: its role, its fact line and its evidence. */
export function slotView(
  s: LineSession,
  clockNow: Clock,
  line: LineSnapshot,
): SlotView {
  const { nowMs, timeZone } = clockNow;
  const kind = sessionKind(s, nowMs);
  const created = Date.parse(s.createdAt);
  const account = line.accounts.find((a) => a.name === s.account);
  const evidence: EvidenceRow[] = [
    ...(s.title === null ? [] : [{ k: "title", v: s.title }]),
    { k: "repository", v: s.repo },
    {
      k: "launched",
      v: `${clock(created, timeZone)}, ${ago(created, nowMs)} ago`,
    },
    ...driveEvidence(s, nowMs),
    ...specificEvidence(s, kind, clockNow, account),
    ...(s.url === null ? [] : [{ k: "link", v: s.url, copy: s.url }]),
    { k: "record", v: s.record, copy: s.record },
    ...(s.workspace === null
      ? []
      : [{ k: "workspace", v: s.workspace, copy: s.workspace }]),
  ];
  return {
    record: s.record,
    account: s.account,
    repo: s.repo,
    target: s.target,
    title: s.title,
    url: s.url,
    noLink: s.url === null ? noLinkText(s.repo, s.target) : null,
    stage: s.stage,
    mark: stageMark(s.stage),
    role: roleFor(s, kind),
    fact: factOf(s, kind, clockNow, Date.parse(line.startedAt)),
    kind,
    evidence,
  };
}

// ---------- accounts ----------

export function wallIsUp(a: LineAccount, nowMs: number): boolean {
  return a.wall !== null && Date.parse(a.wall.resetAt) > nowMs;
}

export interface AccountView {
  name: string;
  vendor: string;
  heldText: string;
  /** One entry per slot: whether it is held. */
  pips: boolean[];
  state: string | null;
  wall: string | null;
  walled: boolean;
  free: boolean;
}

/** An account's row: how full it is and why it takes nothing, if it does not. */
export function accountView(a: LineAccount, clockNow: Clock): AccountView {
  const { nowMs, timeZone } = clockNow;
  const walled = wallIsUp(a, nowMs);
  const atCap = a.held >= a.cap;
  let state: string | null = null;
  let wall: string | null = null;
  if (walled && a.wall !== null) {
    const reset = Date.parse(a.wall.resetAt);
    state = "behind a wall";
    wall = `lifts ${clock(reset, timeZone)}, in ${until(reset, nowMs)}`;
  } else if (a.wallUnrecorded) {
    state = "behind a wall";
    wall =
      "a launch ended on this wall and it was never recorded; a person clears that record";
  } else if (a.notAdmitted !== null) {
    state = "not admitted";
    wall = a.notAdmitted;
  } else if (atCap) {
    state = "at cap";
  }
  return {
    name: a.name,
    vendor: a.vendor,
    heldText: `${a.held} of ${a.cap}`,
    pips: Array.from({ length: a.cap }, (_, i) => i < a.held),
    state,
    wall,
    walled,
    free: !walled && !a.wallUnrecorded && a.notAdmitted === null && !atCap,
  };
}

/** `4 of 10 slots held, 1 wall`. */
export function slotSummary(accounts: LineAccount[], nowMs: number): string {
  const held = accounts.reduce((sum, a) => sum + a.held, 0);
  const cap = accounts.reduce((sum, a) => sum + a.cap, 0);
  const walls = accounts.filter((a) => wallIsUp(a, nowMs)).length;
  return `${held} of ${cap} slots held${walls > 0 ? `, ${plural(walls, "wall")}` : ""}`;
}

/** The account the next admission lands on: the first free one, rotating on from the last launch's. */
export function nextFreeAccount(
  line: LineSnapshot,
  clockNow: Clock,
): string | null {
  const accounts = line.accounts;
  const start = accounts.findIndex((a) => a.name === line.lastAccount);
  for (let i = 1; i <= accounts.length; i++) {
    const candidate = accounts[(start + i) % accounts.length];
    if (candidate !== undefined && accountView(candidate, clockNow).free)
      return candidate.name;
  }
  return null;
}

// ---------- repositories ----------

function hasProblem(r: LineRepo): boolean {
  return r.refused !== null || r.failedReads.length > 0;
}

/** `5 repositories, 2 with a read or setup problem`. */
export function repoSummary(repos: LineRepo[]): string {
  const problems = repos.filter(hasProblem).length;
  return `${plural(repos.length, "repository", "repositories")}${problems > 0 ? `, ${problems} with a read or setup problem` : ""}`;
}

/** A repository's line in the fold: its stages, then what was refused, failed or noted. */
export function repoRow(r: LineRepo): { slug: string; note: string } {
  const details = [
    ...(r.refused === null ? [] : [r.refused]),
    ...r.failedReads.map((f) => f.detail),
    ...r.notes,
  ];
  return {
    slug: r.slug ?? r.path,
    note: [r.stages.join(", "), ...details].filter((x) => x !== "").join(". "),
  };
}
