/**
 * What needs a person, and the answer to whether anything does, as pure functions
 * of the line. Only what a record holds is stated.
 */
import type {
  LineDecision,
  LineLinks,
  LineNeed,
  LineReady,
  NeedCause,
  LineOption,
  LineSession,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import {
  ACT_WORDS,
  type Act,
} from "../../plugin/skills/drive-pr/scripts/lib/merge-ready.ts";
import {
  actOfLineNeed,
  NEED_ACTS,
  type NeedAct,
} from "../../plugin/shared/acts.ts";
import { uniqueLogins } from "../../plugin/shared/forge-logins.ts";
import { refusedRepos } from "../../plugin/dispatch/lib/line-unread.ts";
import { answerStateWords } from "../../plugin/shared/decision-card.ts";
import { ago, clock, plural } from "./format.ts";
import type { EveryoneAnswerState } from "./icons.ts";
import { type DecisionRow, decisionRows } from "./picking.ts";
import { noLinkText } from "./links.ts";
import { itemWords, trackerOf, type Tracker } from "./tracker-name.ts";
import { type SendTarget, sendTargetOf } from "./send-target.ts";
import {
  questionGroupId,
  questionGroups,
} from "../../plugin/shared/question-group.ts";
import {
  groupedNeedView,
  type QuestionGroupView,
} from "./question-group-view.ts";
import { ROLES, type Role } from "./status.ts";
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
  /** What the answers that keep a decision waiting say, one line per decision that has any, with the state they leave it in. */
  acted: Array<{
    key: string;
    option: string;
    author: string;
    outcome: "done" | "refused" | "held" | null;
    detail: string | null;
  }>;
  answerNotes: Array<{ state: EveryoneAnswerState; text: string }>;
  /** Who it waits on, as the parks name them; empty when no record names anyone. */
  people: string[];
  target: string;
  /** The target's title as the line holds it; `null` when no read gave one. */
  title: string | null;
  repo: string;
  stage: string;
  age: string;
  role: Role;
  /** The cause the line recorded, which the meta line draws beside its words. */
  cause: NeedCause;
  recorded: string;
  classNote: string;
  question: string | null;
  /** What the run the need is about concluded, from its closing report, beside the question as context; `null` without one. */
  concluded: string | null;
  recommendation: string | null;
  /** The whole decision as Markdown; `null` when the record holds none. */
  decision: string | null;
  url: string | null;
  noLink: string | null;
  /** The work the line links it to; absent when the line does not say. */
  links?: LineLinks;
  /** The decision keys a person answers, each with a line `answer <key>: …`. */
  answerKeys: string[];
  /** One row per decision, oldest first, each picked on its own. */
  rows: DecisionRow[];
  /** Where the card's Send posts its answers, or why it has none (`send-target.ts`). */
  send: { to: SendTarget } | { absent: string };
  /** What Copy key takes when there is no link. */
  keyText: string | null;
  foldLabel: string;
  evidence: EvidenceRow[];
  /** For the one card of a question group: every target it covers (`question-group-view.ts`); absent on a need's own card. */
  group?: QuestionGroupView;
}

/** The act a need asks for, as `jig ask` names it. */
const needAct: (n: LineNeed) => NeedAct = actOfLineNeed;

/** Who a need waits on: every person its parks name. */
function needPeople(n: LineNeed): string[] {
  return uniqueLogins(
    n.decisions.flatMap((d) => (d.person === undefined ? [] : [d.person])),
  );
}

function recordedWord(n: LineNeed, tracker: Tracker): string {
  if (n.cause === "stopped-unknown")
    return "repeated no-cause stops (needs a person)";
  if (n.cause === "parked") return "parked for a person";
  if (n.cause === "assigner-cannot-write") return "assigner cannot write";
  if (n.cause === "tracker-unreachable")
    return `${itemWords(tracker).name ?? "issues"} unreachable`;
  if (n.cause === "account-sign-in") return "sign-in refused";
  if (n.cause === "account-startup") return "repeated startup failures";
  return n.cause;
}

/** What a work item's card with no link says. */
function noLinkOf(n: LineNeed, tracker: Tracker): string | null {
  if (
    n.url !== null ||
    n.repo === "host" ||
    n.cause === "state-storage" ||
    n.cause === "tracker-unreachable"
  )
    return null;
  return noLinkText(n.repo, n.target, tracker);
}

/** Each decision's waiting answers in words, named by its key when the need has several. */
function answerNotes(decisions: LineDecision[]): NeedView["answerNotes"] {
  return decisions.flatMap((d) => {
    const prefix = decisions.length > 1 ? `${d.key}: ` : "";
    const notes: NeedView["answerNotes"] = [];
    const said = answerStateWords(d.answerState, d.answers ?? []);
    if (said !== null)
      notes.push({
        state: d.answerState ?? "from the line",
        text: `${prefix}${said}`,
      });
    if (d.unread !== undefined)
      notes.push({
        state: "waiting",
        text: `${prefix}Answers not read, so it still waits: ${d.unread}`,
      });
    return notes;
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
          ? n.notified.detail === undefined
            ? n.notified.outcome
            : `${n.notified.outcome}: ${n.notified.detail}`
          : `${clock(Date.parse(n.notified.at), timeZone)}${to}${n.notified.detail === undefined ? "" : `; now ${n.notified.outcome}: ${n.notified.detail}`}`,
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

/** The card's note on the decision it leads with: its class, when named, and its kind. */
function classNoteOf(first: LineDecision | undefined): string {
  if (first === undefined) return "";
  const named = first.decisionClass ?? null;
  return `${named === null ? "" : `, class ${named}`}, ${first.kind}`;
}

/** The recommendation in words; a record whose recommended option reads in full shows that option instead. */
function recommendationLine(
  first: LineDecision | undefined,
  recommended: NeedView["recommended"],
): string | null {
  const recommendation = first?.recommendation ?? null;
  return recommendation === null || recommended !== null
    ? null
    : `Recommended: ${recommendation}`;
}

/** The destination the station's reader names, checked against its link. */
function sendFor(n: LineNeed, rows: DecisionRow[]): NeedView["send"] {
  const answer = n.decisions[0]?.answer;
  return sendTargetOf({
    repo: n.repo,
    pr: n.pr,
    url: n.url,
    target: n.target,
    parked: n.cause === "parked" && rows.length > 0,
    ...(answer === undefined
      ? {}
      : {
          answerOn: answer.on,
          ...(answer.repository === undefined
            ? {}
            : { answerRepository: answer.repository }),
        }),
  });
}

/** One need as its row shows it. */
export function needView(
  n: LineNeed,
  clockNow: Clock,
  tracker?: Tracker,
): NeedView {
  const first = n.decisions[0];
  // A park's question is its first decision's; a follow-up's is the line it stopped on.
  const question = first?.question ?? n.question ?? null;
  const decision = decisionText(n.decisions);
  // The card leads with the oldest decision's options; the steps of every open decision go in its fold.
  const options = first?.options ?? [];
  const recommended = options.find((o) => o.recommended) ?? null;
  const rows = decisionRows(n.decisions);
  return {
    rowKey: `${n.repo} ${n.target} ${n.cause}`,
    act: needAct(n),
    recommended,
    otherOptions: options.filter((o) => o !== recommended),
    steps: [...new Set(n.decisions.flatMap((d) => d.steps ?? []))],
    answerNotes: answerNotes(n.decisions),
    acted: n.decisions.flatMap((d) =>
      d.acted == null ? [] : [{ key: d.key, ...d.acted }],
    ),
    people: needPeople(n),
    target: n.target,
    title: n.title,
    repo: n.repo,
    stage: n.stage,
    age: ago(Date.parse(n.since), clockNow.nowMs),
    role: ROLES.needs,
    cause: n.cause,
    recorded: recordedWord(n, tracker),
    classNote: classNoteOf(first),
    question: question ?? n.reason,
    concluded: n.concluded ?? null,
    recommendation: recommendationLine(first, recommended),
    decision,
    url: n.url,
    noLink: noLinkOf(n, tracker),
    ...(n.links === undefined ? {} : { links: n.links }),
    answerKeys: [...new Set(n.decisions.map((d) => d.key))],
    rows,
    send: sendFor(n, rows),
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

export interface ReadyNeedView {
  rowKey: string;
  /** What the person does about it, which groups the card in Needs you. */
  act: NeedAct;
  /** The board's specific person act in words; `null` when absent. */
  boardAct: string | null;
  target: string;
  title: string;
  repo: string;
  url: string;
  age: string;
  role: Role;
  says: string;
  command: string;
  failing: string[];
  failingOmitted: number;
  conditions: LineReady["conditions"];
  unblocks: number[];
  /** The work the line links it to; absent when the line does not say. */
  links?: LineLinks;
}

/** How each board person-act groups under Needs you's closed acts (design/dispatch-board.md § What each card waits on). */
const READY_ACT_GROUP: Record<Act, NeedAct> = {
  merge: "Merge",
  approve: "Authorize",
  "request-review": "Authorize",
  "update-branch": "Do",
  answer: "Reply",
  "re-arm": "Investigate",
  "re-run-check": "Do",
  "mark-ready": "Do",
  "remove-label": "Do",
  "open-pr": "Do",
};

function readyNeedAct(r: LineReady): NeedAct {
  return r.act === null ? "Investigate" : READY_ACT_GROUP[r.act];
}

function readySince(r: LineReady, fallback: string): string {
  return Number.isFinite(Date.parse(r.since)) ? r.since : fallback;
}

/** Converged pull requests the board read placed in Needs you, skipping any PR that already has a need on the line. */
function readyNeeds(line: LineSnapshot): LineReady[] {
  return (line.ready ?? []).filter(
    (r) =>
      r.place === "needs-you" &&
      r.lane === null &&
      !line.needs.some((n) => n.repo === r.repo && n.pr === r.pr),
  );
}

/** One converged pull request placed in Needs you by the board read, as its card shows it. */
function readyNeedView(
  r: LineReady,
  line: LineSnapshot,
  clockNow: Clock,
): ReadyNeedView {
  const since = readySince(r, line.finishedAt);
  return {
    rowKey: `${r.repo} ${r.pr} ${r.head}`,
    act: readyNeedAct(r),
    boardAct: r.act === null ? null : ACT_WORDS[r.act],
    target: `PR #${r.pr}`,
    title: r.title,
    repo: r.repo,
    url: r.url,
    age: ago(Date.parse(since), clockNow.nowMs),
    role: ROLES.needs,
    says: r.says,
    command: `jig ask drive@${r.repo}#${r.pr}`,
    failing: r.failing,
    failingOmitted: r.failingOmitted,
    conditions: r.conditions,
    unblocks: r.unblocks,
    ...(r.links === undefined ? {} : { links: r.links }),
  };
}

export type NeedRow =
  | { type: "head"; head: string }
  | { type: "need"; need: NeedView; since: string }
  | { type: "ready"; ready: ReadyNeedView; since: string }
  | { type: "stuck"; slot: SlotView; since: string };

/** A need's card, or the one card of a question group of two or more, where its oldest need would be. */
function needCardOf(
  first: LineNeed,
  more: LineNeed[],
  line: LineSnapshot,
  clockNow: Clock,
): NeedView {
  const viewed = (n: LineNeed) => ({
    need: n,
    view: needView(n, clockNow, trackerOf(line, n.repo)),
  });
  const lead = viewed(first);
  const id = questionGroupId(first);
  return more.length === 0 || id === null
    ? lead.view
    : groupedNeedView(lead, more.map(viewed), id);
}

/**
 * The rows of Needs you: one group per act, in the acts' order, then the
 * sessions not moving. Needs whose decisions are identical apart from their
 * own target are one card (`shared/question-group.ts`). Converged pull
 * requests the board read placed in Needs you join their mapped act group,
 * oldest first. Filtered to one person, only the needs that wait on them
 * stay; board cards and sessions not moving name nobody, so they go too.
 */
export function needRows(
  line: LineSnapshot,
  clockNow: Clock,
  person: string | null = null,
): NeedRow[] {
  const rows: NeedRow[] = [];
  const ordered = orderedNeeds(line.needs).filter((n) => waitsOn(n, person));
  const board = person === null ? readyNeeds(line) : [];
  for (const act of NEED_ACTS) {
    const list = ordered.filter((n) => needAct(n) === act);
    const readyList = board.filter((r) => readyNeedAct(r) === act);
    if (list.length === 0 && readyList.length === 0) continue;
    rows.push({ type: "head", head: act });
    const grouped: Array<Extract<NeedRow, { type: "need" | "ready" }>> = [];
    for (const [first, ...more] of questionGroups(list))
      if (first !== undefined)
        grouped.push({
          type: "need",
          need: needCardOf(first, more, line, clockNow),
          since: first.since,
        });
    for (const r of readyList)
      grouped.push({
        type: "ready",
        ready: readyNeedView(r, line, clockNow),
        since: readySince(r, line.finishedAt),
      });
    grouped.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));
    rows.push(...grouped);
  }
  if (person !== null) return rows;
  const stuck = notMoving(line, clockNow.nowMs).sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  if (stuck.length > 0) {
    rows.push({ type: "head", head: "Not moving" });
    for (const s of stuck)
      rows.push({
        type: "stuck",
        slot: slotView(s, clockNow, line),
        since: s.createdAt,
      });
  }
  return rows;
}

/** Counts records needing a person without formatting evidence that belongs inside a panel. */
export function needCount(line: LineSnapshot | null, nowMs: number): number {
  return line === null
    ? 0
    : line.needs.length +
        readyNeeds(line).length +
        notMoving(line, nowMs).length;
}

/** Whether What needs you exists on this page, which decides the page's shape. */
export function hasNeedRows(line: LineSnapshot | null, nowMs: number): boolean {
  return (
    line !== null &&
    (line.needs.length > 0 ||
      readyNeeds(line).length > 0 ||
      (line.answeredHolds?.length ?? 0) > 0 ||
      (line.settled?.length ?? 0) > 0 ||
      notMoving(line, nowMs).length > 0)
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
  const board = readyNeeds(line);
  const all = NEED_ACTS.flatMap((act) => {
    const entries: Array<
      | { kind: "need"; need: LineNeed; sinceMs: number }
      | { kind: "ready"; ready: LineReady; sinceMs: number }
    > = [
      ...line.needs
        .filter((n) => needAct(n) === act)
        .map((need) => ({
          kind: "need" as const,
          need,
          sinceMs: Date.parse(need.since),
        })),
      ...board
        .filter((r) => readyNeedAct(r) === act)
        .map((ready) => ({
          kind: "ready" as const,
          ready,
          sinceMs: Date.parse(readySince(ready, line.finishedAt)),
        })),
    ];
    return entries.sort((a, b) => a.sinceMs - b.sinceMs);
  });
  const first = all[0];
  const tickClock = clock(Date.parse(line.startedAt), timeZone);
  const unread = unreadText(line, timeZone);
  if (first !== undefined) {
    const oldest = Math.min(...all.map((e) => e.sinceMs));
    const stuckText =
      stuck > 0 ? `${plural(stuck, "session")} not moving. ` : "";
    const firstText =
      first.kind === "need"
        ? `${first.need.target}, ${recordedWord(first.need, trackerOf(line, first.need.repo))}`
        : `PR #${first.ready.pr}, ${first.ready.act === null ? "converged, needs a person" : `converged, ${ACT_WORDS[first.ready.act]}`}`;
    return {
      title: pastTense
        ? `${all.length} needed a person at the ${tickClock} tick.`
        : all.length === 1
          ? "1 needs a person."
          : `${all.length} need a person.`,
      sub: `Oldest ${ago(oldest, nowMs)}. ${stuckText}${plural(moving, "session")} working. First: ${firstText}.${unread === null ? "" : ` ${unread}`}`,
      loud: true,
    };
  }
  return quietBand(line, nowMs, {
    moving,
    stuck,
    tickClock,
    pastTense,
    unread,
  });
}

/**
 * The repositories whose newest read was refused, as `jig ask --waiting`
 * names them, each with the tick its part is from: `1 repository not read:
 * acme/web, as of 15:00.`; `null` when the line read every one.
 */
export function unreadText(
  line: LineSnapshot,
  timeZone: string,
): string | null {
  const unread = refusedRepos(line);
  if (unread.length === 0) return null;
  const each = unread.map((r) =>
    r.readAt === null
      ? `${r.repo}, never read`
      : `${r.repo}, as of ${clock(Date.parse(r.readAt), timeZone)}`,
  );
  return `${plural(unread.length, "repository", "repositories")} not read: ${each.join("; ")}.`;
}

/** The answer when no need is open: sessions not moving still count, a repository not read is named, and a quiet line says what runs and what waits. */
function quietBand(
  line: LineSnapshot,
  nowMs: number,
  facts: {
    moving: number;
    stuck: number;
    tickClock: string;
    pastTense: boolean;
    unread: string | null;
  },
): AnswerView {
  const { moving, stuck, tickClock, pastTense, unread } = facts;
  const walled = line.accounts.filter((a) => wallIsUp(a, nowMs)).length;
  const wallText =
    walled > 0 ? `; ${plural(walled, "account")} behind a wall` : "";
  const queueText =
    line.queue.length > 0
      ? `${plural(line.queue.length, "item")} queued`
      : "queue empty";
  const unreadLead = unread === null ? "" : `${unread} `;
  const sub = `${unreadLead}${plural(moving, "session")} working${wallText}; ${queueText}.`;
  if (stuck > 0)
    return {
      title: pastTense
        ? `${plural(stuck, "session")} not moving at the ${tickClock} tick.`
        : `${plural(stuck, "session")} not moving.`,
      sub,
      loud: true,
    };
  // A repository the line could not read may hold a need it cannot show, so the answer does not say nothing does.
  if (unread !== null)
    return {
      title: pastTense
        ? `Nothing needed a person in what the ${tickClock} tick read.`
        : "Nothing needs a person in what was read.",
      sub,
      loud: true,
    };
  return {
    title: pastTense
      ? `Nothing needed a person at the ${tickClock} tick.`
      : "Nothing needs a person.",
    sub,
    loud: false,
  };
}
