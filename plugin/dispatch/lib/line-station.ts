/**
 * The framed decision a need other than a drive's park carries on the line:
 * the one its pass recorded with its result (`framed-result.ts`), else the
 * one the tick frames from the facts its action holds
 * (`shared/decisions/station.ts`), and where a person answers it.
 *
 * A cause the tick has no step for beside leaving it (a double claim, an
 * unanswered nudge, an item assigned by someone who cannot write) carries
 * none, and keeps its free text.
 */
import type { LineDecision, NeedCause } from "./dashboard-contract.ts";
import { decisionOf } from "./line-decision.ts";
import { decisionDigest } from "../../shared/decisions/digest.ts";
import {
  type AnswerStation,
  frameStationDecision,
  type StationAnswer,
  type StationDecision,
  type StationFacts,
  type StationKey,
} from "../../shared/decisions/station.ts";
import type { Action, Evidence } from "./types.ts";

/** What the line knows of a need's repository and target beside its action. */
export interface StationContext {
  slug: string;
  /** The open pull requests that carry an item; `null` when the tick could not tell. */
  carriedBy(item: string): readonly number[] | null;
  /** Whether the repository's items are the forge's own issues. */
  itemsOnForge: boolean;
}

/** The context a repository's line input gives its needs' decisions: the act phase and the line build it alike, so both frame the same decision. */
export function stationContextOf(
  slug: string,
  input:
    | {
        links?: import("./work-links.ts").WorkLinks | null | undefined;
        tracker?: { adapter: string } | null | undefined;
      }
    | undefined,
): StationContext {
  const links = input?.links;
  return {
    slug,
    carriedBy: (item) => {
      if (links == null) return null;
      const prs = links.prsOf(item);
      return prs === null ? null : prs.map((p) => p.number);
    },
    itemsOnForge: input?.tracker?.adapter === "github",
  };
}

function text(evidence: Evidence, field: string): string | null {
  const value = evidence[field];
  return typeof value === "string" && value !== "" ? value : null;
}

function count(evidence: Evidence, field: string): number | null {
  const value = evidence[field];
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

function prOf(target: string): number | null {
  const found = /^PR #(\d+)$/.exec(target);
  return found === null ? null : Number(found[1]);
}

/** A stage's station, as `jig send` addresses it. */
function stationOfStage(stage: string | null): AnswerStation | null {
  if (stage === "rearm" || stage === "takeover") return "drive";
  if (stage === "followup") return "followup";
  if (stage === "pickup") return "pickup";
  return null;
}

type NeedAction = Action & { cause: NeedCause };

function followupFailedFacts(action: NeedAction): StationFacts | null {
  const pr = prOf(action.target);
  const { evidence } = action;
  return pr === null
    ? null
    : {
        kind: "followup-failed",
        pr,
        record: text(evidence, "record"),
        marker: count(evidence, "marker"),
        question: text(evidence, "question"),
      };
}

function followupStaleFacts(action: NeedAction): StationFacts | null {
  const pr = prOf(action.target);
  const marker = count(action.evidence, "marker");
  return pr === null || marker === null
    ? null
    : {
        kind: "followup-stale",
        pr,
        marker,
        released: count(action.evidence, "released"),
      };
}

function stalledFacts(
  action: NeedAction,
  ctx: StationContext,
): StationFacts | null {
  return prOf(action.target) !== null
    ? null
    : {
        kind: "stalled",
        item: action.target,
        state: text(action.evidence, "state") ?? "a dispatch state",
        idleSince: text(action.evidence, "idleSince"),
        carriedBy: ctx.carriedBy(action.target),
      };
}

function pickupQuestionFacts(action: NeedAction): StationFacts | null {
  const record = text(action.evidence, "record");
  const question = text(action.evidence, "question");
  return prOf(action.target) !== null || record === null || question === null
    ? null
    : { kind: "pickup-question", item: action.target, record, question };
}

function pickupEndedFacts(
  action: NeedAction,
  ctx: StationContext,
): StationFacts | null {
  const record = text(action.evidence, "record");
  return prOf(action.target) !== null || record === null
    ? null
    : {
        kind: "pickup-ended",
        item: action.target,
        record,
        ended: text(action.evidence, "ended"),
        carriedBy: ctx.carriedBy(action.target),
      };
}

/** How each cause the tick frames reads its facts. */
const FACTS: Partial<
  Record<
    NeedCause,
    (action: NeedAction, ctx: StationContext) => StationFacts | null
  >
> = {
  "followup-failed": followupFailedFacts,
  "followup-stale": followupStaleFacts,
  stalled: stalledFacts,
  "pickup-question": pickupQuestionFacts,
  "pickup-ended": pickupEndedFacts,
  "needs-person": (action) => needsPersonFacts(action, prOf(action.target)),
  "stopped-unknown": (action) => needsPersonFacts(action, prOf(action.target)),
};

/** The facts the tick frames a need's decision from; `null` for a cause it frames none for. */
function factsOf(action: NeedAction, ctx: StationContext): StationFacts | null {
  const stuck = text(action.evidence, "stuck");
  const record = text(action.evidence, "record");
  if (stuck !== null && record !== null)
    return { kind: "launch", target: action.target, record };
  return FACTS[action.cause]?.(action, ctx) ?? null;
}

function needsPersonFacts(
  action: Action & { cause: NeedCause },
  pr: number | null,
): StationFacts | null {
  const { evidence, target } = action;
  const holder = text(evidence, "holder");
  const branch = text(evidence, "branch");
  if (holder !== null && branch !== null)
    return { kind: "checkout", target, branch, path: holder };
  if (pr === null) return null;
  const exit = evidence.exit;
  return {
    kind: "drive",
    pr,
    exit:
      typeof exit === "number" || (typeof exit === "string" && exit !== "")
        ? String(exit)
        : null,
    started: text(evidence, "started"),
    failedRearm: text(evidence, "failedRearm"),
  };
}

/** The station a need's decision is answered through, by its key and the stage its action names. */
function stationOf(
  key: StationKey,
  action: Action,
  stage: string | null,
): AnswerStation {
  if (key === "followup") return "followup";
  if (key === "pickup") return "pickup";
  if (key === "drive") return "drive";
  return (
    stationOfStage(stage) ?? (prOf(action.target) === null ? "pickup" : "drive")
  );
}

/** Where a person answers `key` on `action`'s target. */
function answerOf(
  key: StationKey,
  action: Action,
  ctx: StationContext,
  framedBy: StationAnswer["framedBy"],
): StationAnswer {
  const station = stationOf(key, action, text(action.evidence, "stage"));
  const pr = prOf(action.target);
  const address =
    pr === null
      ? `${station}@${ctx.slug}#${action.target.replace(/^#/, "")}`
      : `${station}@${ctx.slug}#${pr}`;
  return {
    station,
    address,
    on: pr !== null ? "pull-request" : ctx.itemsOnForge ? "issue" : "tracker",
    framedBy,
  };
}

/** The key a pass's own decision is answered by: its stage's. */
function sessionKey(cause: NeedCause): StationKey | null {
  if (cause === "followup-failed") return "followup";
  if (cause === "pickup-question") return "pickup";
  return null;
}

/** What the tick read and did for `decision`, when it read its answers this tick for the same framing. */
function answeredOf(
  action: Action,
  decision: LineDecision,
): Pick<LineDecision, "answers" | "answerState" | "acted"> {
  const answered = action.answered;
  if (answered === undefined || answered.digest !== decision.digest) return {};
  const acted = answered.acted;
  return {
    ...(answered.answers.length === 0 ? {} : { answers: answered.answers }),
    ...(answered.state === undefined ? {} : { answerState: answered.state }),
    ...(acted === undefined
      ? {}
      : {
          acted: {
            option: acted.option,
            author: acted.author,
            outcome: acted.outcome,
            detail: acted.detail,
          },
        }),
  };
}

/**
 * The decision `action`'s need carries, as the line shows it, with the
 * answers the tick read for it, and where it is answered; `null` when it
 * carries none.
 */
export function stationDecision(
  action: Action & { cause: NeedCause },
  ctx: StationContext,
): LineDecision | null {
  const decision = framedDecision(action, ctx);
  return decision === null
    ? null
    : { ...decision, ...answeredOf(action, decision) };
}

function framedDecision(
  action: Action & { cause: NeedCause },
  ctx: StationContext,
): LineDecision | null {
  const own = sessionKey(action.cause);
  if (own !== null && action.framed !== undefined)
    return {
      ...decisionOf({
        key: own,
        kind: "finding",
        decision: action.framed.decision,
        digest: action.framed.digest,
        parkedAt: action.framed.at,
        lines: [],
      }),
      answer: answerOf(own, action, ctx, "session"),
    };
  const facts = factsOf(action, ctx);
  if (facts === null) return null;
  const framed: StationDecision = frameStationDecision(facts);
  return {
    ...decisionOf({
      key: framed.key,
      kind: "finding",
      decision: framed.decision,
      digest: decisionDigest(framed.decision),
      lines: [],
    }),
    answer: answerOf(framed.key, action, ctx, "dispatcher"),
  };
}
