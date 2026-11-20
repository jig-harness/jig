/**
 * A person's answers to the decisions the line's needs carry, other than a
 * drive's parks, and the tick's step on the one that counts.
 *
 * Each tick on the host that owns the repository reads the comments on each
 * framed need's pull request, or its item: a forge issue where the items are
 * the forge's issues, else the item on its tracker (`tracker-answers.ts`),
 * whose trusted authors count as the forge's members do. Every comment goes
 * through the reader every station shares (`answer-forms.ts`), with the same
 * rule for who may answer (`shared/trusted-authors.ts`). A dispatcher does
 * not answer on a person's behalf, so a comment by its own forge login, or by
 * the user its tracker credential acts as, is left out, unless it carries the
 * record `jig send` writes (`shared/decisions/answer-record.ts`), naming that
 * identity, this decision's key and the option its answer line chooses: that
 * is a person who shares the identity. The record proves no authorship, since
 * whatever holds the identity's credential could write one; it keeps the
 * reader from taking the dispatcher's own comments for answers, and asks more
 * than a drive's park reader, which reads the same comment without it.
 * A need whose only answers on its tracker item are that user's, none of them
 * sent, reads as unread, with why, so whoever wrote them learns the tick will
 * not act.
 * An answer counts only when it names the decision's current digest, so a
 * word typed for earlier facts never acts on new ones; each person's latest
 * answer is theirs, and two that differ leave the need disputed. A free
 * answer is shown and never acted on: the tick carries out an option, not
 * words.
 *
 * The counted answer's step runs once (`station-answer-store.ts`): the row
 * is claimed first, the step checks its preconditions again and runs or
 * refuses with why, and the outcome is kept. For a decision the tick framed
 * the step is the option's (`StationPorts`); for one a pass framed, it
 * starts that stage again, a follow-up run again or a pickup released,
 * whose next session is handed the chosen option. A need answered with the hold option leaves Needs you for these facts.
 */
import {
  answerView,
  type AnswerState,
  type ShownAnswer,
} from "../../shared/decision-card.ts";
import {
  stationOptionId,
  type StationOptionId,
} from "../../shared/decisions/station.ts";
import { optionNameMatches } from "../../shared/decisions/answer-normalize.ts";
import { readSentAnswer } from "../../shared/decisions/answer-record.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  type CommentLike,
  disputedAnswers,
  latestAnswers,
  parseAnswerComment,
} from "../../skills/drive-pr/scripts/lib/answer-forms.ts";
import type { ParkedItem } from "../../skills/drive-pr/scripts/lib/state/park-frame.ts";
import type { PendingAnswer } from "../../skills/drive-pr/scripts/lib/state/pass-handoff.ts";
import type { LineDecision, NeedCause } from "./dashboard-contract.ts";
import { type StationContext, stationDecision } from "./line-station.ts";
import { isTakenNeed, owedTags, takenDecision } from "./release-groups.ts";
import type { TrackerConversation } from "./tracker-answers.ts";
import {
  claimedAt,
  type ActedAnswer,
  actedAnswer,
  type AnswerRow,
  type CarriedAnswer,
  claimAnswer,
  finishAnswer,
} from "./station-answer-store.ts";
import type { Action, RepoReport } from "./types.ts";
import { currentMs, isoFromMs, parseMs } from "../../shared/time.ts";

/** Before any park: a decision the tick framed has no park time, and its digest binds an answer. */
const EPOCH = "1970-01-01T00:00:00.000Z";

/** The answers read for a need's decision, as the line shows them, and the tick's step on the one that counts. */
export interface StationAnswered {
  digest: string;
  answers: ShownAnswer[];
  state?: AnswerState;
  /** Why the answers could not be read; absent when they were. */
  unread?: string;
  acted?: ActedAnswer;
}

/** What the reading of one decision's comments found. */
interface AnswerReading {
  answers: PendingAnswer[];
  state?: AnswerState;
  /** The answer every person agrees on, a structured one naming the current digest; absent when none counts. */
  counted?: PendingAnswer;
}

/** The parked item the shared reader and `jig send` read a station's decision as. */
export function stationItem(decision: LineDecision): ParkedItem {
  return {
    key: decision.key,
    kind: "finding",
    reason: decision.question ?? decision.key,
    round: 0,
    at: decision.parkedAt ?? EPOCH,
    ...(decision.decision === undefined ? {} : { decision: decision.decision }),
    ...(decision.digest === undefined ? {} : { digest: decision.digest }),
  };
}

/** The comments by the dispatcher's own identity that may answer, and the name their records carry. */
interface OwnComments {
  name: string;
  comments: readonly CommentLike[];
}

/** `c` read as an answer to `decision`; one that names no digest, or another, is stale. */
function answerOf(
  decision: LineDecision,
  c: CommentLike,
): PendingAnswer | null {
  const answer = parseAnswerComment(
    stationItem(decision),
    c,
    "conversation",
    decision.answer?.framedBy === "dispatcher",
  );
  if (answer === null) return null;
  // A structured answer acts only when it names the framing it answers.
  return answer.choice !== undefined && answer.digest !== decision.digest
    ? { ...answer, stale: true as const }
    : answer;
}

/** Whether the record's option `recorded` is the option `read` names, the retired hold spelling included. */
function sameOption(
  decision: LineDecision,
  read: string,
  recorded: string | undefined,
): boolean {
  if (recorded === undefined) return false;
  if (read === recorded) return true;
  const option = decision.options?.find((o) => o.name === read);
  return option !== undefined && optionNameMatches(option, recorded, true);
}

/**
 * `c`, by the dispatcher's own identity `name`, read as an answer to
 * `decision`: only with a sent answer's record naming that identity and this
 * decision's key. An answer whose record does not name the decision's digest
 * and the option its line chooses is stale, as any author's answer to other
 * facts is, so the need shows it rather than losing it.
 */
function ownAnswerOf(
  decision: LineDecision,
  c: CommentLike,
  name: string,
): PendingAnswer | null {
  const sent = readSentAnswer(c.body);
  if (
    sent === null ||
    sent.login.toLowerCase() !== name.toLowerCase() ||
    sent.key.toLowerCase() !== decision.key.toLowerCase()
  )
    return null;
  const answer = answerOf(decision, c);
  if (answer === null) return null;
  const { choice } = answer;
  return answer.stale !== true &&
    sent.decision === decision.digest &&
    choice !== undefined &&
    sent.choice !== undefined &&
    sameOption(decision, choice.option, sent.choice.option) &&
    choice.form === sent.choice.form
    ? answer
    : { ...answer, stale: true };
}

/** A release's decision changes as versions are tagged, so an answer to an earlier list does not stand in the way of one to this list. */
function currentReleaseAnswers(
  decision: LineDecision,
  answers: PendingAnswer[],
): PendingAnswer[] {
  const current = answers.filter((a) => a.stale !== true);
  return decision.key === "release" && current.length > 0 ? current : answers;
}

/** The answers `comments` and the dispatcher's `own` give `decision`: each person's latest. */
function readStationAnswers(
  decision: LineDecision,
  comments: readonly CommentLike[],
  own: OwnComments | null,
): AnswerReading {
  const parsed = [
    ...comments.map((c) => answerOf(decision, c)),
    ...(own === null
      ? []
      : own.comments.map((c) => ownAnswerOf(decision, c, own.name))),
  ].filter((a) => a !== null);
  const answers = currentReleaseAnswers(decision, latestAnswers(parsed));
  if (answers.length === 0) return { answers };
  if (answers.some((a) => a.stale === true)) return { answers, state: "stale" };
  if (disputedAnswers(answers)) return { answers, state: "disputed" };
  const [first] = answers;
  return first?.choice === undefined
    ? { answers }
    : { answers, counted: first };
}

/**
 * Whether the tick would count `body`, by the dispatcher's own identity
 * `login`, as choosing `option` of `decision`: what `jig send` checks before
 * it writes as a user the tick may leave out.
 */
export function countsAsSent(
  decision: LineDecision,
  body: string,
  login: string,
  option: string,
): boolean {
  const parked = parseMs(stationItem(decision).at ?? EPOCH);
  const at = isoFromMs(Math.max(currentMs(), parked + 1000));
  const comment = { author: login, association: "MEMBER", at, url: "", body };
  const { counted } = readStationAnswers(decision, [], {
    name: login,
    comments: [comment],
  });
  return counted?.choice?.option === option;
}

/** The steps the tick takes on a person's answer, each checking its preconditions again before it acts: what it did, or why it refused. */
export interface StationPorts {
  /** The conversation comments of pull request or forge issue `number` in `repo`. */
  comments(
    repo: string,
    number: number,
  ): Promise<Outcome<CommentLike[], "unreadable">>;
  /**
   * The comments of item `item` on a tracker other than the forge, each
   * author named by the tracker and the tracker's own user's kept apart; why
   * not, for a tracker that cannot name who wrote a comment.
   */
  trackerComments(
    item: string,
  ): Promise<Outcome<TrackerConversation, "unreadable">>;
  /** The dispatcher's own forge login, whose comments answer only with a sent answer's record. */
  self: string | null;
  /** Where the items are the forge's issues, the repository they are in; `null` otherwise. */
  issueRepository: string | null;
  rerunFollowup(
    pr: number,
    marker: number,
  ): Promise<Outcome<string, "refused">>;
  rerunReleaseGates?(tag: string): Promise<Outcome<string, "refused">>;
  /** Record that a person took these releases' next step under `decision`; `null` returns them to the line. */
  takeReleases?(tags: readonly string[], decision: string | null): void;
  doneFollowup(pr: number, marker: number): Promise<Outcome<string, "refused">>;
  /** `record` is the ended pickup's launch record the need names, released with the claim. */
  releasePickup(
    item: string,
    record?: string | null,
  ): Promise<Outcome<string, "refused">>;
  detachCheckout(
    target: string,
    branch: string,
    path: string,
    stage?: string | null,
  ): Promise<Outcome<string, "refused">>;
  rearmDrive(pr: number): Promise<Outcome<string, "refused">>;
  clearRecord(record: string): Promise<Outcome<string, "refused">>;
}

const refused = (reason: string) => failed("refused", reason);

function evidenceNumber(action: Action, field: string): number | null {
  const value = action.evidence[field];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function evidenceText(action: Action, field: string): string | null {
  const value = action.evidence[field];
  return typeof value === "string" && value !== "" ? value : null;
}

function prOf(target: string): number | null {
  const found = /^PR #(\d+)$/.exec(target);
  return found === null ? null : Number(found[1]);
}

/** A follow-up run again, or recorded done, on the marker the need names. */
function followupStep(
  action: Action,
  ports: StationPorts,
  done: boolean,
): Promise<Outcome<string, "refused">> {
  const pr = prOf(action.target);
  const marker = evidenceNumber(action, "marker");
  if (pr === null || marker === null)
    return Promise.resolve(
      refused(
        "the need names no follow-up marker to release; delete the follow-up's marker by hand to run it again",
      ),
    );
  return done
    ? ports.doneFollowup(pr, marker)
    : ports.rerunFollowup(pr, marker);
}

const notHere = (why: string) => Promise.resolve(refused(why));

/** Re-run every release's gates, one refusal leaving the others to go on, and say how each went. */
async function rerunEach(
  tags: readonly string[],
  rerun: (tag: string) => Promise<Outcome<string, "refused">>,
): Promise<Outcome<string, "refused">> {
  const lines: string[] = [];
  let refusals = 0;
  for (const tag of tags) {
    const outcome = await rerun(tag);
    if (!outcome.ok) refusals += 1;
    lines.push(
      `${tag}: ${outcome.ok ? outcome.value : outcome.failure.reason}`,
    );
  }
  const detail = lines.join("; ");
  return refusals === 0 ? ok(detail) : refused(detail);
}

/** Each dispatcher option's step on a need, by option id. */
const DISPATCHER_STEPS: Readonly<
  Record<
    StationOptionId,
    (
      action: Action,
      ports: StationPorts,
      pr: number | null,
    ) => Promise<Outcome<string, "refused">>
  >
> = {
  hold: () => Promise.resolve({ ok: true, value: "left to a person" }),
  gates: (action, ports) => {
    const tags = owedTags(action.evidence);
    const [only] = tags;
    const { rerunReleaseGates: rerun } = ports;
    if (only === undefined || rerun === undefined)
      return notHere("the release's failed gates cannot be retried here");
    return tags.length === 1 ? rerun(only) : rerunEach(tags, rerun);
  },
  inspect: () => Promise.resolve(ok("a person took the release investigation")),
  tag: () => Promise.resolve(ok("a person took the manual tagging step")),
  rerun: (action, ports) => followupStep(action, ports, false),
  done: (action, ports) => followupStep(action, ports, true),
  release: (action, ports, pr) =>
    pr === null
      ? ports.releasePickup(action.target, evidenceText(action, "record"))
      : notHere("only an item's claim is released"),
  detach: (action, ports) => {
    const branch = evidenceText(action, "branch");
    const path = evidenceText(action, "holder");
    return branch === null || path === null
      ? notHere("the need names no checkout to detach")
      : ports.detachCheckout(
          action.target,
          branch,
          path,
          evidenceText(action, "stage"),
        );
  },
  rearm: (_action, ports, pr) =>
    pr === null
      ? notHere("only a pull request's drive is re-armed")
      : ports.rearmDrive(pr),
  clear: (action, ports) => {
    const record = evidenceText(action, "record");
    return record === null
      ? notHere("the need names no launch record")
      : ports.clearRecord(record);
  },
};

/** The step a dispatcher's option takes on `action`'s need. */
function dispatcherStep(
  id: StationOptionId,
  action: Action,
  ports: StationPorts,
): Promise<Outcome<string, "refused">> {
  return DISPATCHER_STEPS[id](action, ports, prOf(action.target));
}

/** The step a pass's own decision takes: its stage started again, its next session handed the option chosen. */
function sessionStep(
  action: Action & { cause: NeedCause },
  ports: StationPorts,
): Promise<Outcome<string, "refused">> {
  if (action.cause === "followup-failed")
    return followupStep(action, ports, false);
  return prOf(action.target) === null
    ? ports.releasePickup(action.target, evidenceText(action, "record"))
    : Promise.resolve(refused("only an item's pickup is started again"));
}

/** What the next session is handed for a counted answer, for a step that starts one. */
function carriedOf(
  decision: LineDecision,
  answer: PendingAnswer,
): CarriedAnswer | null {
  const choice = answer.choice;
  if (choice === undefined) return null;
  const option = decision.options?.find((o) => o.name === choice.option);
  return {
    question: decision.question ?? "",
    option: choice.option,
    recommended: choice.recommended,
    changes: option?.changes ?? "",
    costs: option?.costs ?? "",
    ...(choice.note === undefined ? {} : { note: choice.note }),
    by: answer.author,
    url: answer.url,
  };
}

/**
 * The steps that start a session, whose answer the next one is handed. A
 * step the tick carries out whole is not one of them: after `release` the
 * next launch is an ordinary fresh pickup, and an answer handed to it would
 * read as its task, which the tick already did.
 */
const STARTS_SESSION: ReadonlySet<StationOptionId | "session"> = new Set([
  "session",
  "rerun",
]);

/** The step a counted answer takes, or `undefined` when it names none the dispatcher carries out. */
function stepOf(
  decision: LineDecision,
  counted: PendingAnswer,
): StationOptionId | "session" | undefined {
  return decision.answer?.framedBy === "session"
    ? "session"
    : stationOptionId(counted.choice?.option ?? "");
}

/** What the session a step starts is handed; `null` for a step that starts none. */
function carryOf(
  step: StationOptionId | "session" | undefined,
  decision: LineDecision,
  counted: PendingAnswer,
): CarriedAnswer | null {
  return step !== undefined && STARTS_SESSION.has(step)
    ? carriedOf(decision, counted)
    : null;
}

/** Run the counted answer's step once, and keep how it ended. */
async function act(
  action: Action & { cause: NeedCause },
  decision: LineDecision,
  counted: PendingAnswer,
  row: AnswerRow,
  ports: StationPorts,
  root: string | undefined,
): Promise<ActedAnswer> {
  const choice = counted.choice?.option ?? "";
  const step = stepOf(decision, counted);
  const outcome =
    step === undefined
      ? refused(`${choice} is not an option the dispatcher carries out`)
      : step === "session"
        ? await sessionStep(action, ports)
        : await dispatcherStep(step, action, ports);
  const handedOff = step === "hold" || step === "inspect" || step === "tag";
  const ended = !outcome.ok ? "refused" : handedOff ? "held" : "done";
  const detail = outcome.ok ? outcome.value : outcome.failure.reason;
  const carry = outcome.ok ? carryOf(step, decision, counted) : null;
  finishAnswer(row, ended, detail, carry, root);
  return {
    option: choice,
    author: counted.author,
    answer: row.answer,
    outcome: ended,
    detail,
  };
}

/** Where a need's answers are: a pull request or forge issue, or an item of another tracker. */
type Where =
  | { on: "forge"; repo: string; number: number }
  | { on: "tracker"; item: string };

/** Where the comments that answer a need are, or `null` where answers are not read. */
function whereAnswered(
  action: Action,
  decision: LineDecision,
  slug: string,
  ports: StationPorts,
): Where | null {
  const pr = prOf(action.target);
  if (pr !== null) return { on: "forge", repo: slug, number: pr };
  if (decision.answer?.on === "tracker")
    return { on: "tracker", item: action.target };
  const issue = /^#(\d+)$/.exec(action.target);
  if (decision.answer?.on !== "issue" || issue === null) return null;
  return ports.issueRepository === null
    ? null
    : { on: "forge", repo: ports.issueRepository, number: Number(issue[1]) };
}

function isStationNeed(
  action: Action,
): action is Action & { cause: NeedCause } {
  return (
    action.stage === "notify" &&
    action.cause !== undefined &&
    action.cause !== "parked"
  );
}

/** Where one need's answers are read, and what they are read against. */
interface Framed {
  action: Action & { cause: NeedCause };
  decision: LineDecision;
  digest: string;
  where: Where;
}

/** A need's decision and where its answers are, or `null` when its answers are not read. */
function framedOf(
  action: Action,
  slug: string,
  context: StationContext,
  ports: StationPorts,
): Framed | null {
  if (!isStationNeed(action)) return null;
  const decision = stationDecision(action, context);
  const digest = decision?.digest;
  if (decision === null || digest === undefined) return null;
  const where = whereAnswered(action, decision, slug, ports);
  return where === null ? null : { action, decision, digest, where };
}

/** How long a claimed answer may have no outcome before its step is taken to have been interrupted. */
const INTERRUPTED_AFTER_MS = 10 * 60_000;

/**
 * An answer claimed long ago with no outcome: its step stopped partway (a
 * crash, a thrown port call). Whether its effect landed cannot be told from
 * here, so it ends refused, saying so, rather than standing unreported; a
 * person who answers again, as a new comment, has it carried out afresh.
 */
function settleInterrupted(
  row: AnswerRow,
  prior: ActedAnswer,
  root: string | undefined,
): ActedAnswer {
  const age = currentMs() - parseMs(claimedAt(row, root) ?? "");
  if (prior.outcome !== null || !(age > INTERRUPTED_AFTER_MS)) return prior;
  const detail =
    "the tick stopped partway through this step, so whether it took effect is not known; check the need's facts, and answer again to have it carried out afresh";
  finishAnswer(row, "refused", detail, null, root);
  return { ...prior, outcome: "refused", detail };
}

/** The step on `counted` as its row holds it, the step run now when no tick ran it yet. */
async function actedOn(
  framed: Framed,
  counted: PendingAnswer,
  slug: string,
  ports: StationPorts,
  root: string | undefined,
): Promise<ActedAnswer | null> {
  const { action, decision, digest } = framed;
  const row: AnswerRow = {
    repo: slug,
    target: action.target,
    key: decision.key,
    digest,
    answer: `${counted.url} ${counted.at}`,
    author: counted.author,
    option: counted.choice?.option ?? "",
  };
  const prior = actedAnswer(row, root);
  if (prior !== null) return settleInterrupted(row, prior, root);
  return claimAnswer(
    row,
    carryOf(stepOf(decision, counted), decision, counted),
    root,
  )
    ? act(action, decision, counted, row, ports, root)
    : actedAnswer(row, root);
}

/** The comments at a need's place: everyone else's, the dispatcher's own that may answer, and on a tracker its own user's, kept to say why they are not read. */
interface Conversation {
  comments: CommentLike[];
  sent: OwnComments | null;
  own: TrackerConversation["own"] | null;
}

/** The comments at `where`, the dispatcher's own identity's kept apart. */
async function conversationAt(
  where: Where,
  ports: StationPorts,
): Promise<Outcome<Conversation, "unreadable">> {
  if (where.on === "tracker") {
    const read = await ports.trackerComments(where.item);
    if (!read.ok) return read;
    const { comments, own } = read.value;
    return ok({
      comments,
      own,
      sent: { name: own.name, comments: own.sent ?? [] },
    });
  }
  const listed = await ports.comments(where.repo, where.number);
  if (!listed.ok) return listed;
  const { self } = ports;
  const mine = (c: CommentLike) =>
    c.author.toLowerCase() === self?.toLowerCase();
  return ok({
    comments: listed.value.filter((c) => !mine(c)),
    own: null,
    sent:
      self === null
        ? null
        : { name: self, comments: listed.value.filter(mine) },
  });
}

/** Why a need's answers are not read when the only ones on its tracker item are by the user the tick's tracker credential acts as; `null` otherwise. */
function ownOnly(
  decision: LineDecision,
  read: AnswerReading,
  own: TrackerConversation["own"],
  item: string,
): string | null {
  if (read.answers.length > 0) return null;
  if (readStationAnswers(decision, own.comments, null).answers.length === 0)
    return null;
  return `the only answer on ${item} is by ${own.name}, the user the dispatcher's own tracker credential acts as, whose comments the tick counts only with the record jig send writes; answer with jig send, answer on the tracker as another user, or give the dispatcher a tracker user of its own`;
}

/** Read one need's answers onto its action and act on the one that counts; whether it was answered I'll handle it — hide this card. */
async function settleOne(
  framed: Framed,
  slug: string,
  ports: StationPorts,
  root: string | undefined,
): Promise<boolean> {
  const { action, decision, digest, where } = framed;
  const listed = await conversationAt(where, ports);
  if (!listed.ok) {
    action.answered = { digest, answers: [], unread: listed.failure.reason };
    return false;
  }
  const { comments, own, sent } = listed.value;
  const read = readStationAnswers(decision, comments, sent);
  const unread =
    own === null || where.on !== "tracker"
      ? null
      : ownOnly(decision, read, own, where.item);
  if (unread !== null) {
    action.answered = { digest, answers: [], unread };
    return false;
  }
  const answered: StationAnswered = {
    digest,
    answers: read.answers.map(answerView),
    ...(read.state === undefined ? {} : { state: read.state }),
  };
  action.answered = answered;
  if (read.counted === undefined) return false;
  const acted = await actedOn(framed, read.counted, slug, ports, root);
  if (acted !== null) answered.acted = acted;
  return acted?.outcome === "held";
}

/**
 * Releases held by a person's answer keep its decision while other versions
 * change; when the answer no longer holds them they return to the line. A read
 * that failed has not revoked the hold, so those releases stay off the line:
 * the answer says whether they are held now.
 */
function keepReleasesTaken(
  action: Action,
  isHeld: boolean,
  ports: StationPorts,
): boolean {
  const tags = owedTags(action.evidence);
  if (isHeld) ports.takeReleases?.(tags, takenDecision(action));
  else if (isTakenNeed(action.evidence)) {
    if (action.answered?.unread !== undefined) return true;
    ports.takeReleases?.(tags, null);
  }
  return false;
}

/**
 * Read the answers to every framed need of `report` and act on the one
 * that counts, once; a need answered I'll handle it — hide this card moves to the report's
 * quiet entries, so it is neither notified nor shown for these facts.
 */
export async function settleStationAnswers(
  slug: string,
  report: RepoReport,
  context: StationContext,
  ports: StationPorts,
  root?: string,
): Promise<void> {
  const held = new Set<Action>();
  for (const action of report.actions) {
    const framed = framedOf(action, slug, context, ports);
    if (framed === null) continue;
    const isHeld = await settleOne(framed, slug, ports, root);
    if (isHeld) held.add(action);
    if (
      action.cause === "release-owed" &&
      keepReleasesTaken(action, isHeld, ports)
    )
      held.add(action);
  }
  if (held.size === 0) return;
  report.actions = report.actions.filter((a) => !held.has(a));
  for (const action of held)
    report.quiet.push({
      target: action.target,
      class: "answered-hold",
      why: answeredHoldWhy(action),
    });
}

/** Why an answered need sits among the report's quiet entries. */
function answeredHoldWhy(action: Action): string {
  if (action.cause !== "release-owed")
    return `${action.answered?.acted?.author ?? "a person"} chose I'll handle it — hide this card for this ${action.cause ?? "need"}; nothing is done and the work stays where it is; it returns when its facts change`;
  const unread = action.answered?.unread;
  return (
    action.answered?.acted?.detail ??
    `a person took the release step${unread === undefined ? "" : `; its answer could not be refreshed: ${unread}`}`
  );
}
