/**
 * Which comments landing after a held reply are transparent to it: a review
 * bot's follow-up that carries no new finding, so the held thread still
 * resolves on the verified push and nobody answers the follow-up.
 *
 * Two kinds of follow-up land there. A bot's **confirmation** after a push
 * ("synchronized as addressed") is a review feature and carries the bot's
 * confirmation marker. A bot's **chat acknowledgement** of a reply
 * ("acknowledged, nothing further requested") is a chat feature, carries the
 * bot's generated-reply marker (its chat marker) and lands on every answered
 * thread every round. A follow-up is transparent when no unquoted line of
 * its body opens with an outcome token, and:
 *
 *  - it carries its author's confirmation marker: a marker measured on a
 *    bot's own comments (`BUILTIN_MARKERS`) applies whether or not
 *    `review.bots` lists the bot, one a `review.bots` entry declares applies
 *    to that bot; or
 *  - its author is listed in `review.bots` (compared by login without regard
 *    to case or a `[bot]` suffix), and it carries that bot's chat marker and
 *    none of the bot's finding shape: no line a severity format for that
 *    login reads as a severity (`lib/severity-formats.ts`), since a chat
 *    reply can embed a fresh finding. Only a recognizer known to be the
 *    bot's can prove that absence: one `review.severity_formats` declares,
 *    a built-in one, or Jig's for the bot named as `review.reviewer_app`.
 *    Jig's format is assumed for `review.bots` logins when no app is named,
 *    and an assumed recognizer proves nothing, so a bot without a known
 *    format has no transparent chat follow-ups, and neither has a bot the
 *    list leaves out.
 *
 * Authorship is by login: an association check cannot tell a bot from a
 * person (both read `NONE`), and logins are unique across users and bots.
 *
 * Anything else is a newer comment and is triaged. No override exists for an
 * agent to assert that a comment is harmless: a comment this predicate
 * cannot classify is triaged, and a guard that refuses a state the agent has
 * verified is a finding about the guard, never a reason to pass it.
 *
 * `resolve-held-thread.ts`, `finish-round.ts`'s pre-push guard and the
 * status gate's held-thread check apply this one predicate, so a change to
 * what counts as transparent cannot land in one caller and not the others.
 */
import { botEntries, type ReviewBot } from "../../../../shared/consumer.ts";
import { reviewBotEntries } from "./overlay.ts";
import {
  hasSeverityFormat,
  normalizeLogin,
  type SeverityFormat,
  severityOf,
} from "./severity-formats.ts";

/** CodeRabbit's GraphQL `author.login` (no `[bot]` suffix). */
export const CODERABBIT_LOGIN = "coderabbitai";

/**
 * The marker CodeRabbit writes into a follow-up it posts only to CONFIRM a
 * reply ("confirmed…", "synchronized as addressed"), and never into one that
 * disputes it. Measured: every CodeRabbit follow-up carrying it was a
 * confirmation.
 */
export const CODERABBIT_CONFIRMATION_MARKER =
  "<!-- coderabbit-skip-review-comment-follow-up -->";

/**
 * The marker CodeRabbit writes into every comment it generates, its chat
 * replies included. Its findings carry it too, which is why a chat
 * acknowledgement is transparent only with no finding shape in its body.
 */
export const CODERABBIT_CHAT_MARKER = "<!-- coderabbit-ai-generated:v1 -->";

/** The markers each known bot uses when its `review.bots` entry names none. */
const BUILTIN_MARKERS: Readonly<
  Record<string, { confirmation_marker: string; chat_marker: string }>
> = {
  [CODERABBIT_LOGIN]: {
    confirmation_marker: CODERABBIT_CONFIRMATION_MARKER,
    chat_marker: CODERABBIT_CHAT_MARKER,
  },
};

/** One bot with the markers in force for it. */
export interface BotMarkers {
  login: string;
  confirmationMarker: string | null;
  chatMarker: string | null;
}

/**
 * The marker an entry declares, the built-in one when it declares none, or
 * `null` when it declares something that is not a marker: an empty or blank
 * string is contained in every body, and a marker is authority to leave a
 * comment untriaged, so a malformed one grants nothing.
 */
function markerOf(
  declared: unknown,
  builtin: string | undefined,
): string | null {
  if (declared === undefined || declared === null) return builtin ?? null;
  return typeof declared === "string" && declared.trim() !== ""
    ? declared
    : null;
}

/**
 * The bots in force and their markers: each `review.bots` entry, a marker it
 * leaves unset taking the built-in one for that login; then each built-in
 * bot the list leaves out, with its measured confirmation marker and no chat
 * marker.
 */
export function botMarkers(
  entries: readonly (string | ReviewBot)[] | undefined,
): BotMarkers[] {
  const listed = botEntries(entries ?? []).map((e) => {
    const builtin = BUILTIN_MARKERS[normalizeLogin(e.login)];
    return {
      login: normalizeLogin(e.login),
      confirmationMarker: markerOf(
        e.confirmation_marker,
        builtin?.confirmation_marker,
      ),
      chatMarker: markerOf(e.chat_marker, builtin?.chat_marker),
    };
  });
  const unlisted = Object.entries(BUILTIN_MARKERS)
    .filter(([login]) => !listed.some((b) => b.login === login))
    .map(([login, m]) => ({
      login,
      confirmationMarker: m.confirmation_marker,
      chatMarker: null,
    }));
  return [...listed, ...unlisted];
}

/**
 * Minimal shape both callers' comment types can supply:
 * `resolve-held-thread.ts` reads GraphQL's nested `author{ login }`,
 * `finish-round.ts` the flattened `author` string
 * `list-unresolved-threads.ts` emits.
 */
export interface ConfirmationCandidate {
  authorLogin: string | null;
  body: string | null;
}

/** Does any unquoted line of `body` open with an outcome token? */
function carriesOutcome(
  body: string,
  qualifyingOutcome: (body: string) => unknown,
): boolean {
  return body
    .split("\n")
    .some(
      (line) =>
        !line.trimStart().startsWith(">") && qualifyingOutcome(line) !== null,
    );
}

/** Does any line of `body` carry a severity line `login`'s formats read? */
export function carriesFindingShape(
  body: string,
  login: string,
  formats?: readonly SeverityFormat[],
): boolean {
  return body
    .split("\n")
    .some((line) => severityOf(line.trim(), login, formats) !== "unknown");
}

/**
 * Is this comment, landing after a held reply, transparent to it? See the
 * module header. `bots` defaults to the configuration's; `formats` to the
 * severity formats in force.
 */
export function isTransparentFollowUp(
  c: ConfirmationCandidate,
  qualifyingOutcome: (body: string) => unknown,
  bots: readonly BotMarkers[] = botMarkers(reviewBotEntries()),
  formats?: readonly SeverityFormat[],
): boolean {
  if (c.authorLogin === null) return false;
  const author = normalizeLogin(c.authorLogin);
  const bot = bots.find((b) => b.login === author);
  if (bot === undefined) return false;
  const body = c.body ?? "";
  if (carriesOutcome(body, qualifyingOutcome)) return false;
  if (bot.confirmationMarker !== null && body.includes(bot.confirmationMarker))
    return true;
  return (
    bot.chatMarker !== null &&
    body.includes(bot.chatMarker) &&
    hasSeverityFormat(author, formats) &&
    !carriesFindingShape(body, author, formats)
  );
}
