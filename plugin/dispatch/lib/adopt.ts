/**
 * The adoption rule (`dispatch.adopt`): which open pull requests with no
 * drive ledger the tick drives as if a person had put the `drive` label on
 * them. One is adopted when, read from the forge's listing:
 *
 * - its author is one the rule names (`authors`), or, where it names none,
 *   the login the dispatcher reads the forge as, which is the identity the
 *   host's sessions open pull requests under;
 * - it was updated within the rule's window (`within`, a week by default);
 * - a bot opened it only where the rule names that bot;
 * - a person's `hold` label is not on it.
 *
 * A draft is adopted like any other, since a pull request opens as a draft
 * and its drive marks it ready. Adoption reads only a pull request with no
 * ledger, so a drive a person stopped, whose ledger records the stop, is
 * never adopted again. Everything after it is a labelled arm's: once per
 * head commit, on an admitted account, behind a serialized area's hold.
 */
import { hasCommand, type LabelConfig } from "./labels.ts";
import type { DispatchSection } from "./types.ts";

/** The rule as one tick applies it: the authors resolved, the window in milliseconds. */
export interface Adoption {
  authors: string[];
  withinMs: number;
}

/** A pull request's author as the forge lists it. */
export interface Author {
  login: string;
  bot: boolean;
}

/** What the rule reads of an open pull request. */
export interface Adoptable {
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
    withinMs: rule.withinMs,
  };
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

/** A login as the rule compares it: case folded, and a GitHub App's `app/<name>` as its `<name>[bot]` account. */
function normalLogin(login: string): string {
  const folded = login.trim().toLowerCase();
  return folded.startsWith("app/") ? `${folded.slice(4)}[bot]` : folded;
}

/** Whether an author is a bot: the forge says so, or its login is an app's. */
function isBot(author: Author): boolean {
  const login = author.login.toLowerCase();
  return author.bot || login.endsWith("[bot]") || login.startsWith("app/");
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
  const updated = Date.parse(pr.updatedAt ?? "");
  if (!Number.isFinite(updated) || nowMs - updated > adoption.withinMs)
    return null;
  return `dispatch.adopt: by ${author.login}${isBot(author) ? " (a bot the rule names)" : ""}, updated ${pr.updatedAt}, within its ${shownWindow(adoption.withinMs)} window`;
}
