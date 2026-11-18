/**
 * The judgment backlog: what no rule of the tick settles and no steward pass
 * has judged yet, derived from facts the tick already read. The steward
 * starts on it alone: an empty backlog, or one whose every member an earlier
 * pass saw, starts no pass.
 */
import type { Database } from "bun:sqlite";
import type { PoolIssue } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { factsOf } from "./actions/drive-hold.ts";
import type { ReadRecord } from "./launches.ts";
import { isNeed } from "./line.ts";
import { decisionOf } from "./line-decision.ts";
import { type StationContext, stationDecision } from "./line-station.ts";
import { stateDb } from "./state.ts";
import {
  type BacklogMember,
  type FramedNeed,
  memberKey,
  rearmableBySteward,
  STEWARD_REFUSED_OPEN,
} from "./steward.ts";
import { causeMembers } from "./steward-causes.ts";
import { missingFacets } from "./steward-facets.ts";
import { resumeSource } from "./steward-resume.ts";
import type { Action, DrivenPr, Running } from "./types.ts";
import type { NeedCause } from "./dashboard-contract.ts";

/** What one repository's tick read, as the backlog needs it. */
export interface BacklogInput {
  slug: string;
  actions: readonly Action[];
  running: readonly Running[];
  drives: readonly DrivenPr[];
  /** The pull requests a person's hold label keeps every stage off. */
  held: ReadonlySet<number>;
  /** The queued items the observe phase already read. */
  queue: readonly PoolIssue[];
  records: readonly ReadRecord[];
  /** The repository's registry classes (`autonomy.park_classes`). */
  parkClasses: readonly string[];
  /** The hold labels a facet is never filled under. */
  labels: { hitl?: string; manualOps?: string };
  station: StationContext;
  /** The members earlier passes judged, so the runs without a report the digest lists are ones no pass saw. */
  judged?: ReadonlySet<string>;
  /** The dispatcher's state directory, where the runs' transcript copies are. */
  root?: string;
}

export interface Backlog {
  members: BacklogMember[];
  /** The needs with no framing, the only targets a steward `need` record may name. */
  needs: Action[];
  framed: FramedNeed[];
}

type NeedAction = Action & { cause: NeedCause };

function text(action: Action, field: string): string | null {
  const value = action.evidence[field];
  return typeof value === "string" && value !== "" ? value : null;
}

/** The facts that make a need this occurrence: a new stop, question or stall is a new member. */
function needFacts(action: Action): string {
  const e = action.evidence;
  return JSON.stringify([
    action.cause ?? null,
    e.question ?? null,
    e.record ?? null,
    e.stuck ?? null,
    e.class ?? null,
    e.head ?? null,
    e.exit ?? null,
    e.generation ?? null,
    e.idleSince ?? null,
    e.marker ?? null,
  ]);
}

/** The framing a need already carries: its drive's open parks, else the decision its pass or the tick framed. */
function framingOf(
  action: NeedAction,
  input: Pick<BacklogInput, "drives" | "station">,
): FramedNeed | null {
  const base = { target: action.target, cause: action.cause };
  if (action.cause === "parked") {
    const pr = /^PR #(\d+)$/.exec(action.target)?.[1];
    const waiting =
      input.drives.find((d) => String(d.number) === pr)?.waiting ?? [];
    if (text(action, "stuck") !== null || waiting.length === 0) return null;
    const first = waiting[0];
    return {
      ...base,
      framedBy: "park",
      question: first === undefined ? null : decisionOf(first).question,
    };
  }
  const decision = stationDecision(action, input.station);
  if (decision === null) return null;
  return {
    ...base,
    framedBy:
      decision.answer?.framedBy === "session" ? "session" : "dispatcher",
    question: decision.question,
  };
}

function idle(input: BacklogInput, target: string): boolean {
  return !input.running.some((r) => r.target === target);
}

function needMembers(
  input: BacklogInput,
): Pick<Backlog, "needs" | "framed"> & { members: BacklogMember[] } {
  const members: BacklogMember[] = [];
  const needs: Action[] = [];
  const framed: FramedNeed[] = [];
  for (const action of input.actions) {
    if (!isNeed(action)) continue;
    const facts = needFacts(action);
    if (
      (action.cause === "stalled" || action.cause === "followup-failed") &&
      idle(input, action.target)
    )
      members.push({ kind: action.cause, target: action.target, facts });
    const framing = framingOf(action, input);
    if (framing !== null) {
      framed.push(framing);
      continue;
    }
    needs.push(action);
    members.push({ kind: "need", target: action.target, facts });
  }
  return { members, needs, framed };
}

function rearmMembers(input: BacklogInput): BacklogMember[] {
  return input.drives
    .filter((pr) => rearmableBySteward(pr, input.held.has(pr.number)))
    .map((pr) => ({
      kind: "rearm",
      target: `PR #${pr.number}`,
      facts: factsOf(pr),
    }));
}

function resumeMembers(input: BacklogInput): BacklogMember[] {
  return input.records
    .filter(
      (r) =>
        r.record.repo === input.slug &&
        !input.records.some((o) => o.record.stewardResume === r.record.id) &&
        "record" in resumeSource(r, input.parkClasses),
    )
    .map((r) => ({ kind: "resume", target: r.record.id, facts: "" }));
}

function facetMembers(input: BacklogInput): BacklogMember[] {
  return input.queue.flatMap((issue) => {
    const missing = missingFacets(issue, input.labels);
    return missing.length === 0
      ? []
      : [
          {
            kind: "facet" as const,
            target: issue.identifier,
            facts: missing.join(","),
          },
        ];
  });
}

/** The judgment backlog of one repository's tick, with its unframed needs and the framings the others carry. */
export function stewardBacklog(input: BacklogInput): Backlog {
  const needs = needMembers(input);
  const members = [
    ...needs.members,
    ...rearmMembers(input),
    ...resumeMembers(input),
    ...facetMembers(input),
    ...causeMembers(
      input.records,
      input.slug,
      input.judged ?? new Set(),
      input.root,
    ),
  ];
  const keyed = new Map(members.map((m) => [memberKey(m), m]));
  return {
    members: [...keyed.values()].sort((a, b) =>
      memberKey(a).localeCompare(memberKey(b)),
    ),
    needs: needs.needs,
    framed: needs.framed,
  };
}

/** Why the steward starts or does not, on the backlog alone. */
export type StewardTrigger =
  | { kind: "empty" }
  | { kind: "judged"; members: number }
  | { kind: "due"; members: number; unjudged: number };

/** An empty backlog starts nothing; one with a member no earlier pass saw is due at once. */
export function stewardTrigger(
  members: readonly BacklogMember[],
  judged: ReadonlySet<string>,
): StewardTrigger {
  if (members.length === 0) return { kind: "empty" };
  const unjudged = members.filter((m) => !judged.has(memberKey(m))).length;
  return unjudged === 0
    ? { kind: "judged", members: members.length }
    : { kind: "due", members: members.length, unjudged };
}

/** How many of a repository's latest passes the judged set reads: a member still waiting is in every one since it appeared. */
const JUDGED_RUNS = 20;

type JudgedRow = { id: string; submitted: number; backlog: string | null };

/** The resumes a pass proposed that the policy refused for now, each only for a pass that was shown it. */
function refusedOpen(
  db: Database,
  rows: readonly JudgedRow[],
): Set<string | null> {
  const marks = rows.map(() => "?").join(",");
  const refused = db
    .query(
      `SELECT run, json_extract(value, '$.record') AS record FROM steward_records WHERE run IN (${marks}) AND effect = ? AND json_extract(value, '$.kind') = 'resume'`,
    )
    .all(...rows.map((r) => r.id), STEWARD_REFUSED_OPEN) as Array<{
    run: string;
    record: string | null;
  }>;
  const proposable = new Set<string>();
  for (const row of rows) {
    const own: unknown = row.backlog === null ? null : JSON.parse(row.backlog);
    if (!Array.isArray(own)) continue;
    for (const m of own)
      if (m?.kind === "resume" && typeof m.target === "string")
        proposable.add(`${row.id}\u0000${m.target}`);
  }
  // A refusal waits on policy only for a resume its own pass was shown.
  return new Set(
    refused
      .filter((r) => proposable.has(`${r.run}\u0000${r.record}`))
      .map((r) => r.record),
  );
}

/**
 * The members the repository's latest steward passes saw in their backlogs:
 * a pass that submitted, or whose launch (`live`) still holds. A pass that
 * ended without submitting judged nothing, and a resume
 * its pass proposed but the policy refused for now (`refused-open`) stays
 * offered, whichever run judged it, so neither suppresses its member.
 */
export function judgedMembers(
  repo: string,
  root?: string,
  live: ReadonlySet<string> = new Set(),
): Set<string> {
  const db = stateDb(root);
  const rows = db
    .query(
      "SELECT id, submitted, json_extract(digest, '$.backlog') AS backlog FROM steward_runs WHERE repo = ? AND json_valid(digest) ORDER BY at_ms DESC LIMIT ?",
    )
    .all(repo, JUDGED_RUNS) as Array<{
    id: string;
    submitted: number;
    backlog: string | null;
  }>;
  const open = refusedOpen(db, rows);
  const judged = new Set<string>();
  for (const row of rows) {
    if (row.backlog === null) continue;
    if (row.submitted !== 1 && !live.has(row.id)) continue;
    const parsed: unknown = JSON.parse(row.backlog);
    if (!Array.isArray(parsed)) continue;
    for (const m of parsed)
      if (
        typeof m?.kind === "string" &&
        typeof m.target === "string" &&
        typeof m.facts === "string" &&
        !(m.kind === "resume" && open.has(m.target))
      )
        judged.add(memberKey(m as BacklogMember));
  }
  return judged;
}
