/**
 * The adoption rule (`dispatch.adopt`): which open pull requests with no
 * drive ledger the tick drives as if a person had put the `drive` label on
 * them. One is adopted when, read from the forge's listing:
 *
 * - its author is one the rule names (`authors`), or, where it names none,
 *   the login the dispatcher reads the forge as, which is the identity the
 *   host's sessions open pull requests under;
 * - it was updated within the rule's window (`within`, a week by default);
 * - a bot opened it only where the rule names that bot, never through the
 *   default author;
 * - a person's `hold` label is not on it;
 * - an automation pull request (`automation.ts`: a bot's the rule does not
 *   name, or one carrying `automation` or an `automation:` label) needs
 *   work: a check fails, it
 *   conflicts with its base, or a review thread is unresolved. Being recent
 *   is not enough for one, so a healthy one is left for a person to merge.
 *
 * A draft is adopted like any other, since a pull request opens as a draft
 * and its drive marks it ready. Adoption reads only a pull request with no
 * ledger, so a drive a person stopped, whose ledger records the stop, is
 * never adopted again. Everything after it is a labelled arm's: once per
 * head commit, on an admitted account, behind a serialized area's hold.
 */
import {
  isAutomation,
  isBot,
  normalLogin,
  type TroubleFacts,
  troubleOf,
} from "./automation.ts";
import { hasCommand, type LabelConfig } from "./labels.ts";
import type { DispatchSection } from "./types.ts";

/** The rule as one tick applies it: the authors resolved, the window in milliseconds. */
export interface Adoption {
  authors: string[];
  /** Whether `authors` came from the repository's section, not from the dispatcher's own login. */
  named: boolean;
  withinMs: number;
}

/** A pull request's author as the forge lists it. */
export interface Author {
  login: string;
  bot: boolean;
}

/** What the rule reads of an open pull request. */
export interface Adoptable extends TroubleFacts {
  author?: Author;
  updatedAt?: string;
  labels?: string[];
}

/** The rule a repository's section turns on, its authors resolved against the dispatcher's own login; `null` when off. */
export function adoptionOf(
  section: Pick<DispatchSection, "adopt">,
  login: string | null,
): Adoption | null {
  const rule = section.adopt;
  if (!rule.enabled) return null;
  return {
    authors: rule.authors ?? (login === null ? [] : [login]),
    named: rule.authors !== null,
    withinMs: rule.withinMs,
  };
}

/** The host's own authors, whose pull requests are never automation by their author: the adoption rule's, else the login the dispatcher reads the forge as. */
export function ownAuthors(
  adoption: Adoption | null,
  login: string | null,
): string[] {
  if (adoption !== null) return adoption.authors;
  return login === null ? [] : [login];
}

/** What the forge record's detail adds for the rule: how many it adopted, or why it adopts none; nothing when off. */
export function adoptionNote(
  adoption: Adoption | null,
  drives: ReadonlyArray<{ evidence: Record<string, unknown> }>,
): string {
  if (adoption === null) return "";
  if (adoption.authors.length === 0)
    return "; dispatch.adopt names no author and the dispatcher's forge login does not read, so it adopts none";
  const adopted = drives.filter((d) => typeof d.evidence.adopted === "string");
  return `; ${adopted.length} adopted by dispatch.adopt (authors ${adoption.authors.join(", ")}, within ${shownWindow(adoption.withinMs)})`;
}

/** A window in the duration grammar the section takes (`168h`, `90m`, `30s`). */
function shownWindow(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

/**
 * Why the rule adopts the pull request, in words for its evidence; `null`
 * when it does not. `labels` are the repository's dispatch labels, where on.
 */
export function adopts(
  pr: Adoptable,
  adoption: Adoption,
  labels: LabelConfig | null,
  nowMs: number,
): string | null {
  const author = pr.author;
  if (author === undefined || author.login === "") return null;
  if (labels !== null && hasCommand(labels, pr.labels, "hold")) return null;
  const named = adoption.authors
    .map(normalLogin)
    .includes(normalLogin(author.login));
  if (!named) return null;
  if (isBot(author) && !adoption.named) return null;
  const updated = Date.parse(pr.updatedAt ?? "");
  if (!Number.isFinite(updated) || nowMs - updated > adoption.withinMs)
    return null;
  const adopted = `dispatch.adopt: by ${author.login}${isBot(author) ? " (a bot the rule names)" : ""}, updated ${pr.updatedAt}, within its ${shownWindow(adoption.withinMs)} window`;
  if (!isAutomation(pr, adoption.authors)) return adopted;
  const trouble = troubleOf(pr);
  if (trouble !== null)
    return `${adopted}; an automation pull request that needs work: ${trouble}`;
  // Only trouble observed admits an automation pull request: a fact the forge did not give in full is unknown, not trouble.
  return null;
}
