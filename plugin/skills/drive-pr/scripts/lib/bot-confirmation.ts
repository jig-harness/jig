/**
 * an earlier change's "a comment landing after a held reply is compatible with that
 * reply only when it is a reviewer bot's own automated confirmation" test,
 * extracted so `resolve-held-thread.ts` and `finish-round.ts`'s pre-push
 * untriaged-thread guard apply the IDENTICAL predicate. Before this
 * extraction each file carried its own copy of the
 * identity+shape check; `finish-round.ts`'s `checkUntriagedThreads` ran
 * BEFORE the push, judged strictly against the literal latest comment, and
 * so refused the round on the very confirmation `resolve-held-thread.ts`'s
 * own exception exists to tolerate — the exception was unreachable in the
 * documented finish-round path whenever CodeRabbit's confirmation landed
 * before the push rather than during the post-push AWAITING_REVIEWER wait
 * (docomply-review, a reference-implementation pull request round 1). A single predicate closes that gap
 * by construction — a future change to what counts as a trusted
 * confirmation cannot land in one caller and not the other.
 */

/**
 * CodeRabbit's GraphQL `author.login` (plain, no `[bot]` suffix — the same
 * identity `summary-findings.ts` keys its own CodeRabbit matcher on).
 */
export const CODERABBIT_LOGIN = "coderabbitai";

/**
 * The marker CodeRabbit writes into a follow-up it posts only to CONFIRM a
 * reply ("confirmed…", "synchronized as addressed"), and never into one that
 * disputes it. Measured on PR #4618: every CodeRabbit follow-up carrying it
 * was a confirmation.
 */
export const CODERABBIT_CONFIRMATION_MARKER =
  "<!-- coderabbit-skip-review-comment-follow-up -->";

/**
 * Minimal shape both callers' own comment types can supply without
 * reshaping themselves around this module: `resolve-held-thread.ts` reads
 * GraphQL's nested `author{ login }` directly, `finish-round.ts` reads the
 * already-flattened `author` string `list-unresolved-threads.ts` emits. The
 * caller maps its own shape into this at the call site rather than either
 * file adopting the other's.
 */
export interface ConfirmationCandidate {
  authorLogin: string | null;
  body: string | null;
}

/**
 * Identity AND shape, both required, fail-closed on anything else:
 *  - author is CodeRabbit's account, by login — an association check
 *    cannot tell a bot from a human (both read `NONE`), and logins are
 *    unique across users and bots, so the login alone is the identity;
 *  - the body carries CodeRabbit's confirmation marker, and no outcome
 *    token of its own.
 * `chatgpt-codex-connector` is deliberately absent: no confirmation shape
 * of its own has been observed, and an unrecognized body must refuse.
 *
 * Takes the outcome-parser as a parameter rather than importing
 * `qualifyingOutcome` itself — both current callers already import it from
 * `./outcome.ts` for their own use, and threading it through keeps this
 * module dependency-free of the outcome grammar's own module.
 */
export function isTrustedBotConfirmation(
  c: ConfirmationCandidate,
  qualifyingOutcome: (body: string) => unknown,
): boolean {
  if (c.authorLogin !== CODERABBIT_LOGIN) return false;
  const body = c.body ?? "";
  if (!body.includes(CODERABBIT_CONFIRMATION_MARKER)) return false;
  return qualifyingOutcome(body) === null;
}
