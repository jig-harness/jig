/**
 * Provisional decisions on the forge: which reply on a thread is provisional,
 * and whether a person has reversed it since.
 *
 * A provisional decision is reversed only by a comment from an owner, member
 * or collaborator (`TRUSTED_ASSOCIATIONS`) after it: on its thread for a
 * provisional reply, or on the pull request with a line `answer <key>: …` for
 * a provisional `decide` ruling, whose record is a pull-request comment. A
 * comment the drive itself writes is never a reversal, by the rule the
 * re-arm reads answers with: one opening with an outcome token, or carrying
 * a hidden marker. An unresolve alone is not a reversal either: the forge
 * records it without an author, and nothing here reads it.
 *
 * The thread readers live in `driver/rearm.ts`, which reads a parked item's
 * answers by the same rule; every read goes through `ghCall`, under its
 * deadline.
 */
import { TRUSTED_ASSOCIATIONS } from "../summary-findings.ts";
import {
  answersKey,
  type CommentLike,
  prComments,
  threadComments,
} from "./driver/rearm.ts";
import { fail } from "./cli.ts";
import { isProvisionalReply, qualifyingOutcome } from "./outcome.ts";
import { run, tsArgv } from "./proc.ts";
import type { UnattendedDecision } from "./state/decisions.ts";

/** A comment as `list-unresolved-threads.ts` emits it, as far as this reads it. */
export interface ListedComment {
  authorAssociation?: unknown;
  body?: unknown;
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * A comment a person wrote, not one the drive's scripts wrote: any comment
 * from an owner, member or collaborator that carries no hidden marker. A
 * person's `**accepted** — fix it` counts too: an outcome token in a
 * person's own words is still that person's verdict.
 */
export function isPersonsComment(association: string, body: string): boolean {
  return TRUSTED_ASSOCIATIONS.has(association) && !body.includes("<!--");
}

/** The index of the last trusted provisional reply in a thread's comments, `-1` for none. */
function lastProvisionalIndex(
  comments: ReadonlyArray<{ association: string; body: string }>,
): number {
  for (let i = comments.length - 1; i >= 1; i--) {
    const c = comments[i];
    if (
      c !== undefined &&
      TRUSTED_ASSOCIATIONS.has(c.association) &&
      isProvisionalReply(c.body)
    )
      return i;
  }
  return -1;
}

/**
 * Whether a listed thread stands on a provisional reply: its last trusted
 * qualifying reply is provisional, and no person commented after it. Such a
 * thread is not work for the drive even while unresolved, since a person
 * who unresolved it without a word has reversed nothing; one a person
 * commented on is a human thread, and the round parks it.
 */
export function standsOnProvisionalReply(
  comments: readonly ListedComment[],
): boolean {
  const list = comments.map((c) => ({
    association: text(c.authorAssociation),
    body: text(c.body),
  }));
  const at = lastProvisionalIndex(list);
  if (at < 0) return false;
  for (const c of list.slice(at + 1)) {
    if (TRUSTED_ASSOCIATIONS.has(c.association) && qualifyingOutcome(c.body))
      return false;
    if (isPersonsComment(c.association, c.body)) return false;
  }
  return true;
}

/**
 * `standsOnProvisionalReply` for one listed thread record, whatever its
 * shape: a truncated or unreadable comment list is never read as standing,
 * so the thread counts as work.
 */
export function listedThreadStandsOnProvisional(t: unknown): boolean {
  if (typeof t !== "object" || t === null) return false;
  const { comments, commentsTruncated } = t as Record<string, unknown>;
  return (
    commentsTruncated === false &&
    Array.isArray(comments) &&
    standsOnProvisionalReply(
      comments.filter(
        (c): c is ListedComment => typeof c === "object" && c !== null,
      ),
    )
  );
}

/**
 * `triage-thread.ts`: a provisional decision is never decided again while
 * it stands. Once a person commented after it, the round parks the thread
 * under `human-thread`, and after that person's answer the thread is
 * triaged like any other.
 */
export function refuseProvisional(
  threadId: string,
  comments: readonly ListedComment[],
  url: string | null,
): void {
  if (standsOnProvisionalReply(comments))
    fail(
      3,
      `triage-thread.ts: thread ${threadId} stands on a provisional decision (${url ?? "no url"}), which is never triaged again. A person's comment on it is parked by the round under human-thread; an unresolve alone changes nothing.`,
    );
}

/**
 * The round gate's unparked threads that stand on a provisional decision:
 * a thread a person unresolved without a word is not work, since nothing
 * reversed it.
 */
export function standingProvisionalKeys(
  threads: ReadonlyArray<{ threadId?: unknown }>,
  parked: ReadonlySet<string>,
): Set<string> {
  return new Set(
    threads
      .filter((t) => !parked.has(String(t.threadId)))
      .filter(listedThreadStandsOnProvisional)
      .map((t) => String(t.threadId)),
  );
}

const lines = (text: string): string[] =>
  text.split("\n").filter((k) => k !== "");

/**
 * The round gate's parked keys, and those of them that hold a reversed
 * provisional decision; `null` when either could not be read, which the
 * gate takes as INDETERMINATE: an unreadable parked set would re-arm work a
 * person parked. drive-state's stderr is passed through; each read is
 * bounded by the helper deadline, and a fired deadline reads as unreadable.
 */
export async function readParkedSets(ctx: {
  driveStateScript: string;
  pr: string;
  helperTimeoutSec: number;
}): Promise<{ keys: Set<string>; reversals: string[] } | null> {
  const read = (cmd: string) =>
    run(tsArgv(ctx.driveStateScript, [cmd, ctx.pr]), {
      stderr: "inherit",
      timeoutSec: ctx.helperTimeoutSec,
    });
  const all = await read("parked-keys");
  if (all.code !== 0) return null;
  const reversals = await read("reversal-parked-keys");
  if (reversals.code !== 0) return null;
  return {
    keys: new Set(lines(all.stdout)),
    reversals: lines(reversals.stdout),
  };
}

/**
 * How many reversed provisional decisions are parked on no live thread or
 * summary finding: a `decide` ruling's key is neither, and a reopened thread
 * may be resolved again, yet each awaits a person and keeps the drive from
 * converging.
 */
export function unlistedReversals(
  reversals: readonly string[],
  threads: ReadonlyArray<{ threadId?: unknown }>,
  summary: { unaddressed: ReadonlyArray<{ fingerprint: string }> },
): number {
  const counted = new Set([
    ...threads.map((t) => String(t.threadId)),
    ...summary.unaddressed.map((f) => f.fingerprint),
  ]);
  return reversals.filter((k) => !counted.has(k)).length;
}

/** The first comment a person wrote after a thread's last provisional reply. */
export function reversalInThread(
  comments: readonly CommentLike[],
): CommentLike | null {
  const at = lastProvisionalIndex(comments);
  if (at < 0) return null;
  return (
    comments
      .slice(at + 1)
      .find((c) => isPersonsComment(c.association, c.body)) ?? null
  );
}

/** The first `answer <key>:` comment a person wrote on the pull request after `after`. */
export function reversalInConversation(
  conversation: readonly CommentLike[],
  key: string,
  after: string,
): CommentLike | null {
  const since = Date.parse(after);
  return (
    conversation.find(
      (c) =>
        Date.parse(c.at) > since &&
        answersKey(c.body, key) &&
        isPersonsComment(c.association, c.body),
    ) ?? null
  );
}

/** A provisional decision's reversal on the forge; `null` for none, `undefined` when unreadable. */
export type ReversalRead = CommentLike | null | undefined;

/**
 * Read each standing provisional decision's reversal, if any. The pull
 * request's conversation is read once, and only when a `decide` ruling is
 * among them.
 */
export async function readReversals(
  pr: string,
  decisions: readonly UnattendedDecision[],
): Promise<Map<UnattendedDecision, ReversalRead>> {
  const out = new Map<UnattendedDecision, ReversalRead>();
  const needsConversation = decisions.some(
    (d) => d.class === "decide-provisional",
  );
  const conversation = needsConversation ? await prComments(pr) : [];
  for (const d of decisions) {
    const key = d.key ?? "";
    if (d.class === "provisional-reply") {
      const thread = await threadComments(key);
      out.set(d, thread === null ? undefined : reversalInThread(thread));
    } else
      out.set(
        d,
        conversation === null
          ? undefined
          : reversalInConversation(conversation, key, d.at),
      );
  }
  return out;
}
