/**
 * What needs a person, and the answer to whether anything does, as pure functions
 * of the line. Only what a record holds is stated.
 */
import type {
  LineDecision,
  LineNeed,
  LineSession,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import { ago, clock, plural } from "./format.ts";
import { ROLES, type Role, stageMark } from "./status.ts";
import {
  type Clock,
  type EvidenceRow,
  isStuck,
  sessionKind,
  type SlotView,
  slotView,
  wallIsUp,
} from "./view.ts";

// ---------- what needs a person ----------

export interface NeedView {
  rowKey: string;
  target: string;
  repo: string;
  stage: string;
  mark: string;
  age: string;
  role: Role;
  recorded: string;
  classNote: string;
  question: string | null;
  recommendation: string | null;
  /** The whole decision as Markdown; `null` when the record holds none. */
  decision: string | null;
  url: string | null;
  goLabel: string | null;
  noLink: string | null;
  /** The decision keys a person answers, each with a line `answer <key>: …`. */
  answerKeys: string[];
  /** What Copy key takes when there is no link. */
  keyText: string | null;
  foldLabel: string;
  evidence: EvidenceRow[];
}

/** The groups a person's list falls into, by what the person does. */
const TO_DECIDE: ReadonlySet<string> = new Set([
  "parked",
  "needs-person",
  "stopped-unknown",
]);

function recordedWord(n: LineNeed): string {
  if (n.cause === "parked") return "parked for a person";
  if (n.cause === "assigner-cannot-write") return "assigner cannot write";
  return n.cause;
}

function goLabelOf(n: LineNeed): string {
  if (n.pr === null) return "Open in the tracker";
  // A stuck launch record has no drive handoff to read; its session is inspected and the record cleared.
  if (n.stuckRecord != null) return "Open the pull request";
  if (n.cause === "needs-person") return "Read the handoff on the pull request";
  if (
    n.cause === "followup-failed" ||
    n.cause === "followup-stale" ||
    n.cause === "nudge-unanswered" ||
    n.cause === "stopped-unknown"
  )
    return "Open the pull request";
  return "Answer on the pull request";
}

function decisionText(decisions: LineDecision[]): string | null {
  const texts = decisions
    .filter((d) => d.lines.length > 0)
    .map((d) => d.lines.join("\n"));
  return texts.length === 0 ? null : texts.join("\n\n");
}

function needEvidence(
  n: LineNeed,
  questionShown: boolean,
  timeZone: string,
): EvidenceRow[] {
  const rows: EvidenceRow[] = [
    ...(n.title === null ? [] : [{ k: "title", v: n.title }]),
    { k: "since", v: clock(Date.parse(n.since), timeZone) },
    ...(n.url === null ? [] : [{ k: "link", v: n.url, copy: n.url }]),
    ...n.decisions.map((d) => ({ k: d.kind, v: d.key, copy: d.key })),
    ...(questionShown ? [{ k: "reason", v: n.reason, copy: n.reason }] : []),
  ];
  if (n.notified !== null) {
    const to =
      n.notified.workspace === null ? "" : `, to ${n.notified.workspace}`;
    rows.push({
      k: "notified",
      v:
        n.notified.at === null
          ? n.notified.outcome
          : `${clock(Date.parse(n.notified.at), timeZone)}${to}`,
    });
  }
  if (n.stuckRecord != null) {
    const clear = `jig dispatch clear ${n.stuckRecord}`;
    rows.push({
      k: "to release",
      v: "a person checks for a session it started, then runs jig dispatch clear",
    });
    rows.push({ k: "clear", v: clear, copy: clear });
  }
  n.workspaces.forEach((path, i) => {
    rows.push({ k: `workspace ${i + 1}`, v: path, copy: path });
  });
  return rows;
}

/** One need as its row shows it. */
export function needView(n: LineNeed, clockNow: Clock): NeedView {
  const first = n.decisions[0];
  // A park's question is its first decision's; a follow-up's is the line it stopped on.
  const question = first?.question ?? n.question ?? null;
  const recommendation = first?.recommendation ?? null;
  const decision = decisionText(n.decisions);
  const named = first?.decisionClass ?? null;
  return {
    rowKey: `${n.repo} ${n.target} ${n.cause}`,
    target: n.target,
    repo: n.repo,
    stage: n.stage,
    mark: stageMark(n.stage),
    age: ago(Date.parse(n.since), clockNow.nowMs),
    role: ROLES.needs,
    recorded: recordedWord(n),
    classNote:
      first === undefined
        ? ""
        : `${named === null ? "" : `, class ${named}`}, ${first.kind}`,
    question: question ?? n.reason,
    recommendation:
      recommendation === null ? null : `Recommended: ${recommendation}`,
    decision,
    url: n.url,
    goLabel: n.url === null ? null : goLabelOf(n),
    noLink:
      n.url === null
        ? `No tracker link: this repository has no tracker base. Look up ${n.target} in the tracker.`
        : null,
    answerKeys: [...new Set(n.decisions.map((d) => d.key))],
    keyText: n.url === null ? n.target : null,
    foldLabel: decision === null ? "Details" : "The whole decision",
    evidence: needEvidence(n, question !== null, clockNow.timeZone),
  };
}

function byAge(a: LineNeed, b: LineNeed): number {
  return Date.parse(a.since) - Date.parse(b.since);
}

/** The needs in the order the page lists them: to decide before to check, oldest first in each. */
export function orderedNeeds(needs: LineNeed[]): LineNeed[] {
  return [
    ...needs.filter((n) => TO_DECIDE.has(n.cause)).sort(byAge),
    ...needs.filter((n) => !TO_DECIDE.has(n.cause)).sort(byAge),
  ];
}

/** The sessions under "Not moving": a stuck launch record already listed as a need is not listed again. */
function notMoving(line: LineSnapshot, nowMs: number): LineSession[] {
  const listed = new Set(
    line.needs.flatMap((n) => (n.stuckRecord == null ? [] : [n.stuckRecord])),
  );
  return line.sessions.filter(
    (s) => isStuck(sessionKind(s, nowMs)) && !listed.has(s.record),
  );
}

export type NeedRow =
  | { type: "head"; head: string }
  | { type: "need"; need: NeedView }
  | { type: "stuck"; slot: SlotView };

/** The rows of What needs you: to decide, to check, then the sessions not moving. */
export function needRows(line: LineSnapshot, clockNow: Clock): NeedRow[] {
  const rows: NeedRow[] = [];
  const push = (list: LineNeed[], head: string) => {
    if (list.length === 0) return;
    rows.push({ type: "head", head });
    for (const n of list)
      rows.push({ type: "need", need: needView(n, clockNow) });
  };
  const ordered = orderedNeeds(line.needs);
  push(
    ordered.filter((n) => TO_DECIDE.has(n.cause)),
    "To decide, on the pull request",
  );
  push(
    ordered.filter((n) => !TO_DECIDE.has(n.cause)),
    "To check",
  );
  const stuck = notMoving(line, clockNow.nowMs);
  if (stuck.length > 0) {
    rows.push({ type: "head", head: "Not moving" });
    for (const s of stuck)
      rows.push({ type: "stuck", slot: slotView(s, clockNow, line) });
  }
  return rows;
}

/** Counts records needing a person without formatting evidence that belongs inside a panel. */
export function needCount(line: LineSnapshot | null, nowMs: number): number {
  return line === null ? 0 : line.needs.length + notMoving(line, nowMs).length;
}

/** Whether What needs you exists on this page, which decides the page's shape. */
export function hasNeedRows(line: LineSnapshot | null, nowMs: number): boolean {
  return (
    line !== null &&
    (line.needs.length > 0 || notMoving(line, nowMs).length > 0)
  );
}

// ---------- the answer ----------

export interface AnswerView {
  title: string;
  sub: string;
  loud: boolean;
}

/** The first question, stated: does anything need a person? */
export function answerBand(
  line: LineSnapshot | null,
  clockNow: Clock,
  logHasRows: boolean,
  pastTense: boolean,
): AnswerView {
  if (line === null)
    return {
      title: "No tick has run on this host.",
      sub: logHasRows
        ? "The timer writes the first receipt at its first tick."
        : "No receipts, no log rows. The timer writes the first receipt at its first tick.",
      loud: false,
    };
  const { nowMs, timeZone } = clockNow;
  const kinds = line.sessions.map((s) => sessionKind(s, nowMs));
  const moving = kinds.filter(
    (k) => k === "working" || k === "takeover",
  ).length;
  const stuck = notMoving(line, nowMs).length;
  const needs = orderedNeeds(line.needs);
  const first = needs[0];
  const tickClock = clock(Date.parse(line.startedAt), timeZone);
  if (first !== undefined) {
    const oldest = Math.min(...needs.map((n) => Date.parse(n.since)));
    const stuckText =
      stuck > 0 ? `${plural(stuck, "session")} not moving. ` : "";
    return {
      title: pastTense
        ? `${needs.length} needed a person at the ${tickClock} tick.`
        : needs.length === 1
          ? "1 needs a person."
          : `${needs.length} need a person.`,
      sub: `Oldest ${ago(oldest, nowMs)}. ${stuckText}${plural(moving, "session")} working. First: ${first.target}, ${recordedWord(first)}.`,
      loud: true,
    };
  }
  return quietBand(line, nowMs, { moving, stuck, tickClock, pastTense });
}

/** The answer when no need is open: sessions not moving still count, and a quiet line says what runs and what waits. */
function quietBand(
  line: LineSnapshot,
  nowMs: number,
  facts: {
    moving: number;
    stuck: number;
    tickClock: string;
    pastTense: boolean;
  },
): AnswerView {
  const { moving, stuck, tickClock, pastTense } = facts;
  const walled = line.accounts.filter((a) => wallIsUp(a, nowMs)).length;
  const wallText =
    walled > 0 ? `; ${plural(walled, "account")} behind a wall` : "";
  const queueText =
    line.queue.length > 0
      ? `${plural(line.queue.length, "item")} queued`
      : "queue empty";
  if (stuck > 0)
    return {
      title: pastTense
        ? `${plural(stuck, "session")} not moving at the ${tickClock} tick.`
        : `${plural(stuck, "session")} not moving.`,
      sub: `${plural(moving, "session")} working${wallText}; ${queueText}.`,
      loud: true,
    };
  return {
    title: pastTense
      ? `Nothing needed a person at the ${tickClock} tick.`
      : "Nothing needs a person.",
    sub: `${plural(moving, "session")} working${wallText}; ${queueText}.`,
    loud: false,
  };
}
