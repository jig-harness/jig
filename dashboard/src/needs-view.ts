/**
 * What needs a person, and the answer to whether anything does, as pure functions
 * of the line. Only what a record holds is stated.
 */
import type {
  LineDecision,
  LineNeed,
  LineOption,
  LineSession,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import {
  actOfLineNeed,
  NEED_ACTS,
  type NeedAct,
} from "../../plugin/shared/acts.ts";
import { uniqueLogins } from "../../plugin/shared/forge-logins.ts";
import { answerStateWords } from "../../plugin/shared/decision-card.ts";
import { ago, clock, plural } from "./format.ts";
import { type DecisionRow, decisionRows } from "./picking.ts";
import { noLinkText } from "./links.ts";
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
  /** What the person does about it, which the card opens with. */
  act: NeedAct;
  /** The option the record recommends, with what it changes and costs; `null` when the record names none. */
  recommended: LineOption | null;
  /** The record's other options, for the fold. */
  otherOptions: LineOption[];
  /** The steps for a person, as a checklist in the fold. */
  steps: string[];
  /** What the answers that keep a decision waiting say, stale or disputed, one line per decision that has any. */
  answerNotes: string[];
  /** Who it waits on, as the parks name them; empty when no record names anyone. */
  people: string[];
  target: string;
  /** The target's title as the line holds it; `null` when no read gave one. */
  title: string | null;
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
  /** One row per decision, oldest first, each picked on its own. */
  rows: DecisionRow[];
  /** What Copy key takes when there is no link. */
  keyText: string | null;
  foldLabel: string;
  evidence: EvidenceRow[];
}

/** The act a need asks for, as `jig ask` names it. */
const needAct: (n: LineNeed) => NeedAct = actOfLineNeed;

/** Who a need waits on: every person its parks name. */
function needPeople(n: LineNeed): string[] {
  return uniqueLogins(
    n.decisions.flatMap((d) => (d.person === undefined ? [] : [d.person])),
  );
}

function recordedWord(n: LineNeed): string {
  if (n.cause === "stopped-unknown")
    return "repeated no-cause stops (needs a person)";
  if (n.cause === "parked") return "parked for a person";
  if (n.cause === "assigner-cannot-write") return "assigner cannot write";
  if (n.cause === "tracker-unreachable") return "tracker unreachable";
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

/** Each decision's waiting answers in words, named by its key when the need has several. */
function answerNotes(decisions: LineDecision[]): string[] {
  return decisions.flatMap((d) => {
    const said = answerStateWords(d.answerState, d.answers ?? []);
    if (said === null) return [];
    return [decisions.length > 1 ? `${d.key}: ${said}` : said];
  });
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
  // The card leads with the oldest decision's options; the steps of every open decision go in its fold.
  const options = first?.options ?? [];
  const recommended = options.find((o) => o.recommended) ?? null;
  return {
    rowKey: `${n.repo} ${n.target} ${n.cause}`,
    act: needAct(n),
    recommended,
    otherOptions: options.filter((o) => o !== recommended),
    steps: [...new Set(n.decisions.flatMap((d) => d.steps ?? []))],
    answerNotes: answerNotes(n.decisions),
    people: needPeople(n),
    target: n.target,
    title: n.title,
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
    // A record whose recommended option reads in full shows that option instead.
    recommendation:
      recommendation === null || recommended !== null
        ? null
        : `Recommended: ${recommendation}`,
    decision,
    url: n.url,
    goLabel: n.url === null ? null : goLabelOf(n),
    noLink: n.url === null ? noLinkText(n.repo, n.target) : null,
    answerKeys: [...new Set(n.decisions.map((d) => d.key))],
    rows: decisionRows(n.decisions),
    keyText: n.url === null ? n.target : null,
    foldLabel: decision === null ? "Details" : "The whole decision",
    evidence: needEvidence(n, question !== null, clockNow.timeZone),
  };
}

function byAge(a: LineNeed, b: LineNeed): number {
  return Date.parse(a.since) - Date.parse(b.since);
}

/** The needs in the order the page lists them: by act, in the acts' order, oldest first in each. */
export function orderedNeeds(needs: LineNeed[]): LineNeed[] {
  return NEED_ACTS.flatMap((act) =>
    needs.filter((n) => needAct(n) === act).sort(byAge),
  );
}

/** Everyone the needs wait on, for the filter, in the order first seen. */
export function needPeopleOf(line: LineSnapshot | null): string[] {
  return line === null ? [] : uniqueLogins(line.needs.flatMap(needPeople));
}

/** Whether a need waits on `person` (`null`: on anyone). */
function waitsOn(n: LineNeed, person: string | null): boolean {
  return (
    person === null ||
    needPeople(n).some((p) => p.toLowerCase() === person.toLowerCase())
  );
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

/**
 * The rows of Needs you: one group per act, in the acts' order, then the
 * sessions not moving. Filtered to one person, only the needs that wait on
 * them stay; a session not moving names nobody, so it goes too.
 */
export function needRows(
  line: LineSnapshot,
  clockNow: Clock,
  person: string | null = null,
): NeedRow[] {
  const rows: NeedRow[] = [];
  const ordered = orderedNeeds(line.needs).filter((n) => waitsOn(n, person));
  for (const act of NEED_ACTS) {
    const list = ordered.filter((n) => needAct(n) === act);
    if (list.length === 0) continue;
    rows.push({ type: "head", head: act });
    for (const n of list)
      rows.push({ type: "need", need: needView(n, clockNow) });
  }
  if (person !== null) return rows;
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
