/**
 * What the drive decided and recovered from without a person, per pull
 * request: the counters `loop-metrics.ts` prints beside the loop's cost, and
 * the validation measure for the `wide` autonomy level.
 *
 * From the pull request's threads (the forge's record, whichever clone drove
 * it): the provisional replies, which of them a person reversed by commenting
 * and when, and the review bots' chat acknowledgements the drive read as
 * transparent. From the drive state this clone holds, else the ledger: the
 * provisional `decide` rulings and their reversals (read again from the
 * pull request's conversation, since a person may answer after the drive
 * stopped), the self-restarts by cause, the re-arms by cause and the
 * takeovers.
 *
 * The measure: the share of provisional decisions a person reversed before
 * the merge (or, for an open pull request, so far). Pooled over the first
 * month a repository runs `wide`, below one in ten documents the dial as
 * available; above, the arbiter's escalations were right and it stays dark.
 */
import { qualifyingOutcome, isProvisionalReply } from "./outcome.ts";
import {
  type BotMarkers,
  botMarkers,
  isTransparentFollowUp,
} from "./bot-confirmation.ts";
import { reviewBotEntries } from "./overlay.ts";
import { reversalInThread } from "./provisional.ts";
import { TRUSTED_ASSOCIATIONS } from "../summary-findings.ts";
import type { UnattendedDecision } from "./state/decisions.ts";
import { countByCause, type DriveEvent } from "./state/events.ts";

/** One thread's share of the counters. */
export interface ThreadAutonomy {
  /** A trusted provisional reply is on the thread. */
  provisional: boolean;
  /** When a person commented after it, reversing it; `null` for never. */
  reversedAt: string | null;
  /** Review-bot chat acknowledgements, which the drive reads as transparent. */
  chatAcknowledgements: number;
  /** The thread was truncated, so its counters are unknown, not zero. */
  incomplete: boolean;
}

const UNREAD: ThreadAutonomy = {
  provisional: false,
  reversedAt: null,
  chatAcknowledgements: 0,
  incomplete: true,
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** A chat acknowledgement: transparent, and by its bot's chat marker rather than a confirmation. */
function isChatAcknowledgement(
  author: string,
  body: string,
  bots: readonly BotMarkers[],
): boolean {
  const bot = bots.find((b) => b.login === author.replace(/\[bot\]$/, ""));
  return (
    bot?.chatMarker != null &&
    body.includes(bot.chatMarker) &&
    !(
      bot.confirmationMarker !== null && body.includes(bot.confirmationMarker)
    ) &&
    isTransparentFollowUp(
      { authorLogin: author, body },
      qualifyingOutcome,
      bots,
    )
  );
}

/**
 * The counters one thread's comments carry; for a truncated thread, whose
 * later comments could say otherwise, none, marked incomplete.
 */
export function threadAutonomy(
  nodes: readonly Record<string, unknown>[],
  truncated: boolean,
  bots: readonly BotMarkers[] = botMarkers(reviewBotEntries()),
): ThreadAutonomy {
  if (truncated) return UNREAD;
  const comments = nodes.map((n) => ({
    author: str((n.author as Record<string, unknown> | null)?.login),
    association: str(n.authorAssociation),
    at: str(n.createdAt),
    url: str(n.url),
    body: str(n.body),
  }));
  return {
    provisional: comments.some(
      (c, i) =>
        i > 0 &&
        TRUSTED_ASSOCIATIONS.has(c.association) &&
        isProvisionalReply(c.body),
    ),
    reversedAt: reversalInThread(comments)?.at ?? null,
    chatAcknowledgements: comments.filter((c) =>
      isChatAcknowledgement(c.author, c.body, bots),
    ).length,
    incomplete: false,
  };
}

/** What this clone's drive state adds, when it holds one. */
export interface DurableAutonomy {
  decisions: readonly UnattendedDecision[];
  events: readonly DriveEvent[];
  takeovers: number;
  /**
   * Provisional `decide` rulings whose reversal could not be checked (the
   * pull request's conversation was unreadable); absent reads as none.
   */
  uncheckedRulings?: number;
}

export interface AutonomyMetrics {
  provisional: number;
  /** Reversed by a person before the merge; for an open pull request, so far. */
  reversedBeforeMerge: number;
  /**
   * The validation measure: reversed over provisional; `null` with none, or
   * while any thread is incomplete or any ruling unchecked, since its
   * decisions or reversals are unknown.
   */
  reversedShare: number | null;
  /** Threads too long to read whole, whose decisions the counts leave out. */
  incompleteThreads: number;
  /** Provisional rulings whose reversal could not be read, so may be undercounted. */
  uncheckedRulings: number;
  transparentAcknowledgements: number;
  /** `null` when this clone holds no drive state for the pull request. */
  restarts: Record<string, number> | null;
  rearms: Record<string, number> | null;
  takeovers: number | null;
}

const before = (at: string | null | undefined, mergedAt: string | null) =>
  at != null &&
  at !== "" &&
  (mergedAt === null || Date.parse(at) <= Date.parse(mergedAt));

export function autonomyMetrics(
  threads: ReadonlyArray<{ autonomy: ThreadAutonomy }>,
  mergedAt: string | null,
  durable: DurableAutonomy | null,
): AutonomyMetrics {
  const rulings = (durable?.decisions ?? []).filter(
    (d) => d.class === "decide-provisional",
  );
  const provisional =
    threads.filter((t) => t.autonomy.provisional).length + rulings.length;
  const reversedBeforeMerge =
    threads.filter(
      (t) => t.autonomy.provisional && before(t.autonomy.reversedAt, mergedAt),
    ).length + rulings.filter((d) => before(d.reversed?.at, mergedAt)).length;
  const incompleteThreads = threads.filter((t) => t.autonomy.incomplete).length;
  const uncheckedRulings = durable?.uncheckedRulings ?? 0;
  return {
    provisional,
    reversedBeforeMerge,
    reversedShare:
      provisional === 0 || incompleteThreads > 0 || uncheckedRulings > 0
        ? null
        : reversedBeforeMerge / provisional,
    incompleteThreads,
    uncheckedRulings,
    transparentAcknowledgements: threads.reduce(
      (n, t) => n + t.autonomy.chatAcknowledgements,
      0,
    ),
    restarts: durable === null ? null : countByCause(durable.events, "restart"),
    rearms: durable === null ? null : countByCause(durable.events, "rearm"),
    takeovers: durable === null ? null : durable.takeovers,
  };
}

function causes(counts: Record<string, number> | null): string {
  if (counts === null) return "not held in this clone";
  const parts = Object.entries(counts).map(([cause, n]) => `${cause} ${n}`);
  return parts.length === 0 ? "none" : parts.join(" · ");
}

/** The report's lines for these counters; none when nothing happened. */
export function renderAutonomyMetrics(a: AutonomyMetrics): string[] {
  const restarts = Object.values(a.restarts ?? {}).reduce((n, v) => n + v, 0);
  const rearms = Object.values(a.rearms ?? {}).reduce((n, v) => n + v, 0);
  if (
    a.provisional === 0 &&
    a.transparentAcknowledgements === 0 &&
    restarts === 0 &&
    rearms === 0 &&
    (a.takeovers ?? 0) === 0 &&
    a.incompleteThreads === 0
  )
    return [];
  const withheld = [
    ...(a.incompleteThreads > 0
      ? [
          `${a.incompleteThreads} thread(s) too long to read whole, whose decisions are not counted`,
        ]
      : []),
    ...(a.uncheckedRulings > 0
      ? [
          `${a.uncheckedRulings} provisional ruling(s) whose reversal could not be read from the conversation`,
        ]
      : []),
  ];
  const share =
    withheld.length > 0
      ? ` (share withheld: ${withheld.join("; ")})`
      : a.reversedShare === null
        ? ""
        : ` (${(a.reversedShare * 100).toFixed(1)}%; wide stays documented as unvalidated until this share, pooled over a month, is under 1 in 10)`;
  return [
    `  autonomy   ${a.provisional} provisional decision(s), ${a.reversedBeforeMerge} reversed by a person before the merge${share}`,
    `             self-restarts: ${causes(a.restarts)} · re-arms: ${causes(a.rearms)} · takeovers: ${a.takeovers ?? "not held in this clone"} · transparent acknowledgements: ${a.transparentAcknowledgements}`,
  ];
}
