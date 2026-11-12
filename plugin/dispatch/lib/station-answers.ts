/**
 * A person's answers to the decisions the line's needs carry, other than a
 * drive's parks, and the tick's step on the one that counts.
 *
 * Each tick on the host that owns the repository reads the comments on each
 * framed need's pull request, or its item where the items are the forge's
 * issues, through the reader every station shares (`answer-forms.ts`), with
 * the same rule for who may answer (`shared/trusted-authors.ts`). A comment
 * by the dispatcher's own login never answers: a dispatcher does not answer
 * on a person's behalf. An answer counts only when it names the decision's
 * current digest, so a word typed for earlier facts never acts on new ones;
 * each person's latest answer is theirs, and two that differ leave the need
 * disputed. A free answer is shown and never acted on: the tick carries out
 * an option, not words.
 *
 * The counted answer's step runs once (`station-answer-store.ts`): the row
 * is claimed first, the step checks its preconditions again and runs or
 * refuses with why, and the outcome is kept. For a decision the tick framed
 * the step is the option's (`StationPorts`); for one a pass framed, it
 * starts that stage again, a follow-up run again or a pickup released,
 * whose next session is handed the chosen option. A need answered Leave it
 * to me leaves Needs you for these facts.
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
import { failed, type Outcome } from "../../shared/outcome.ts";
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
import {
  type ActedAnswer,
  actedAnswer,
  type AnswerRow,
  type CarriedAnswer,
  claimAnswer,
  finishAnswer,
} from "./station-answer-store.ts";
import type { Action, RepoReport } from "./types.ts";

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
export interface AnswerReading {
  answers: PendingAnswer[];
  state?: AnswerState;
  /** The answer every person agrees on, a structured one naming the current digest; absent when none counts. */
  counted?: PendingAnswer;
}

/** The parked item the shared reader reads a station's decision as. */
function itemOf(decision: LineDecision): ParkedItem {
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

/**
 * The answers `comments` give `decision`: each person's latest, the
 * dispatcher's own login's left out; an answer that names no digest, or
 * another, is stale.
 */
export function readStationAnswers(
  decision: LineDecision,
  comments: readonly CommentLike[],
  self: string | null,
): AnswerReading {
  const item = itemOf(decision);
  const mine = self?.toLowerCase() ?? null;
  const parsed = comments
    .filter((c) => c.author.toLowerCase() !== mine)
    .flatMap((c) => {
      const answer = parseAnswerComment(item, c, "conversation");
      if (answer === null) return [];
      // A structured answer acts only when it names the framing it answers.
      return answer.choice !== undefined && answer.digest !== decision.digest
        ? [{ ...answer, stale: true as const }]
        : [answer];
    });
  const answers = latestAnswers(parsed);
  if (answers.length === 0) return { answers };
  if (answers.some((a) => a.stale === true)) return { answers, state: "stale" };
  if (disputedAnswers(answers)) return { answers, state: "disputed" };
  const [first] = answers;
  return first?.choice === undefined
    ? { answers }
    : { answers, counted: first };
}

/** The steps the tick takes on a person's answer, each checking its preconditions again before it acts: what it did, or why it refused. */
export interface StationPorts {
  /** The conversation comments of pull request or forge issue `number` in `repo`. */
  comments(
    repo: string,
    number: number,
  ): Promise<Outcome<CommentLike[], "unreadable">>;
  /** The dispatcher's own forge login, whose comments never answer. */
  self: string | null;
  /** Where the items are the forge's issues, the repository they are in; `null` otherwise. */
  issueRepository: string | null;
  rerunFollowup(
    pr: number,
    marker: number,
  ): Promise<Outcome<string, "refused">>;
  doneFollowup(pr: number, marker: number): Promise<Outcome<string, "refused">>;
  releasePickup(item: string): Promise<Outcome<string, "refused">>;
  detachCheckout(
    target: string,
    branch: string,
    path: string,
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

/** The step a dispatcher's option takes on `action`'s need. */
function dispatcherStep(
  id: StationOptionId,
  action: Action,
  ports: StationPorts,
): Promise<Outcome<string, "refused">> {
  const pr = prOf(action.target);
  switch (id) {
    case "hold":
      return Promise.resolve({ ok: true, value: "left to a person" });
    case "rerun":
      return followupStep(action, ports, false);
    case "done":
      return followupStep(action, ports, true);
    case "release":
      return pr === null
        ? ports.releasePickup(action.target)
        : Promise.resolve(refused("only an item's claim is released"));
    case "detach": {
      const branch = evidenceText(action, "branch");
      const path = evidenceText(action, "holder");
      return branch === null || path === null
        ? Promise.resolve(refused("the need names no checkout to detach"))
        : ports.detachCheckout(action.target, branch, path);
    }
    case "rearm":
      return pr === null
        ? Promise.resolve(refused("only a pull request's drive is re-armed"))
        : ports.rearmDrive(pr);
    case "clear": {
      const record = evidenceText(action, "record");
      return record === null
        ? Promise.resolve(refused("the need names no launch record"))
        : ports.clearRecord(record);
    }
  }
}

/** The step a pass's own decision takes: its stage started again, its next session handed the option chosen. */
function sessionStep(
  action: Action & { cause: NeedCause },
  ports: StationPorts,
): Promise<Outcome<string, "refused">> {
  if (action.cause === "followup-failed")
    return followupStep(action, ports, false);
  return prOf(action.target) === null
    ? ports.releasePickup(action.target)
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

/** The steps that start a session, whose answer the next one is handed. */
const STARTS_SESSION: ReadonlySet<StationOptionId | "session"> = new Set([
  "session",
  "rerun",
  "release",
]);

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
  const step: StationOptionId | "session" | undefined =
    decision.answer?.framedBy === "session"
      ? "session"
      : stationOptionId(choice);
  const outcome =
    step === undefined
      ? refused(`${choice} is not an option the dispatcher carries out`)
      : step === "session"
        ? await sessionStep(action, ports)
        : await dispatcherStep(step, action, ports);
  const ended = !outcome.ok ? "refused" : step === "hold" ? "held" : "done";
  const detail = outcome.ok ? outcome.value : outcome.failure.reason;
  const carry =
    outcome.ok && step !== undefined && STARTS_SESSION.has(step)
      ? carriedOf(decision, counted)
      : null;
  finishAnswer(row, ended, detail, carry, root);
  return {
    option: choice,
    author: counted.author,
    answer: row.answer,
    outcome: ended,
    detail,
  };
}

/** The repository and number whose comments answer a need, or `null` where answers are not read. */
function whereAnswered(
  action: Action,
  decision: LineDecision,
  slug: string,
  ports: StationPorts,
): { repo: string; number: number } | null {
  const pr = prOf(action.target);
  if (pr !== null) return { repo: slug, number: pr };
  const issue = /^#(\d+)$/.exec(action.target);
  if (decision.answer?.on !== "issue" || issue === null) return null;
  return ports.issueRepository === null
    ? null
    : { repo: ports.issueRepository, number: Number(issue[1]) };
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

/**
 * Read the answers to every framed need of `report` and act on the one
 * that counts, once; a need answered Leave it to me moves to the report's
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
    if (!isStationNeed(action)) continue;
    const decision = stationDecision(action, context);
    const digest = decision?.digest;
    if (decision === null || digest === undefined) continue;
    const where = whereAnswered(action, decision, slug, ports);
    if (where === null) continue;
    const listed = await ports.comments(where.repo, where.number);
    if (!listed.ok) {
      action.answered = { digest, answers: [], unread: listed.failure.reason };
      continue;
    }
    const read = readStationAnswers(decision, listed.value, ports.self);
    const answered: StationAnswered = {
      digest,
      answers: read.answers.map(answerView),
      ...(read.state === undefined ? {} : { state: read.state }),
    };
    action.answered = answered;
    const counted = read.counted;
    if (counted === undefined) continue;
    const row: AnswerRow = {
      repo: slug,
      target: action.target,
      key: decision.key,
      digest,
      answer: `${counted.url} ${counted.at}`,
      author: counted.author,
      option: counted.choice?.option ?? "",
    };
    const acted =
      actedAnswer(row, root) ??
      (claimAnswer(row, root)
        ? await act(action, decision, counted, row, ports, root)
        : actedAnswer(row, root));
    if (acted !== null) answered.acted = acted;
    if (acted?.outcome === "held") held.add(action);
  }
  if (held.size === 0) return;
  report.actions = report.actions.filter((a) => !held.has(a));
  for (const action of held)
    report.quiet.push({
      target: action.target,
      class: "answered-hold",
      why: `${action.answered?.acted?.author ?? "a person"} chose Leave it to me for this ${action.cause ?? "need"}; it is not listed again until its facts change`,
    });
}
