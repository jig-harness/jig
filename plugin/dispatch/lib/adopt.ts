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
 *   default author, or where `pull_requests.trusted_automation` lists it.
 *   With `adopt.trusted_automation: false`, every listed bot needs a manual
 *   drive or rearm;
 * - a person's `hold` label is not on it;
 * - an automation pull request (`automation.ts`: a bot's the rule does not
 *   name, or one carrying `automation` or an `automation:` label) needs
 *   work: a check fails, it
 *   conflicts with its base, or a review thread is unresolved. Being recent
 *   is not enough for one, so a healthy one is left for a person to merge;
 *   except a trusted bot's, which is driven to convergence so the Ready
 *   predicate can place it (`trusted-automation.ts`).
 *
 * A draft is adopted like any other, since a pull request opens as a draft
 * and its drive marks it ready. Adoption reads only a pull request with no
 * ledger, so a drive a person stopped, whose ledger records the stop, is
 * never adopted again. Everything after it is a labelled arm's: once per
 * head commit, on an admitted account, behind a serialized area's hold.
 */
import {
  idleAutomation,
  isAutomation,
  isBot,
  normalLogin,
  type TroubleFacts,
  troubleOf,
} from "./automation.ts";
import { hasCommand, type LabelConfig } from "./labels.ts";
import type { DispatchSection } from "./types.ts";
import { parseMs } from "../../shared/time.ts";

/** The rule as one tick applies it: the authors resolved, the window in milliseconds. */
export interface Adoption {
  authors: string[];
  /** Whether `authors` came from the repository's section, not from the dispatcher's own login. */
  named: boolean;
  withinMs: number;
  /** The bots `pull_requests.trusted_automation` names, case folded. */
  trusted: string[];
  excludeTrusted?: true;
  initialAdoptionDisabled?: true;
}

/** A pull request's author as the forge lists it. */
export interface Author {
  login: string;
  bot: boolean;
}

/** What the rule reads of an open pull request. */
export interface Adoptable extends TroubleFacts {
  author?: Author;
  /** Whether its head is in a fork; a trusted bot's pull request is adopted healthy only when this is `false`. */
  isCrossRepository?: boolean;
  updatedAt?: string;
  labels?: string[];
}

/** The rule a repository's section turns on, its authors resolved against the dispatcher's own login; `null` when off. */
export function adoptionOf(
  section: Pick<DispatchSection, "adopt">,
  login: string | null,
): Adoption | null {
  const rule = section.adopt;
  if (!rule.enabled && rule.excludeTrusted !== true) return null;
  return {
    authors: [
      ...new Set([
        ...((rule.enabled ? rule.authors : null) ??
          (login === null ? [] : [login])),
        ...(rule.enabled ? (rule.servedAuthors ?? []) : []),
      ]),
    ],
    named: rule.enabled && rule.authors !== null,
    withinMs: rule.withinMs,
    trusted: rule.trusted ?? [],
    ...(rule.excludeTrusted === true ? { excludeTrusted: true } : {}),
    ...(!rule.enabled ? { initialAdoptionDisabled: true } : {}),
  };
}

/** Whether `pull_requests.trusted_automation` names the bot that opened the pull request. */
export function trustedBot(
  author: Author | undefined,
  adoption: Pick<Adoption, "trusted"> | null,
): boolean {
  if (author === undefined || adoption === null || !isBot(author)) return false;
  return adoption.trusted.includes(normalLogin(author.login));
}

/** A missing author cannot establish that the opt-out allows an automatic drive. */
export function requiresManualTrustedDrive(
  author: Author | undefined,
  adoption: Adoption | null,
): boolean {
  return (
    adoption?.excludeTrusted === true &&
    adoption.trusted.length > 0 &&
    (!author?.login || trustedBot(author, adoption))
  );
}

/** Why a ledger-backed automation pull request may need a person to rearm it. */
export function idleForAdoption(
  pr: TroubleFacts & {
    author?: Author;
    labels?: readonly string[];
    isCrossRepository?: boolean;
  },
  adoption: Adoption | null,
  login: string | null,
): { automationIdle?: true; trustedDriveManual?: true } {
  if (requiresManualTrustedDrive(pr.author, adoption))
    return { trustedDriveManual: true };
  // A trusted bot is exempt from idleness only while its head is known to be
  // in the repository, as first adoption requires.
  const trusted = pr.isCrossRepository === false ? adoption?.trusted : [];
  return idleAutomation(pr, ownAuthors(adoption, login), trusted);
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
  if (adoption === null || adoption.initialAdoptionDisabled === true) return "";
  if (
    adoption.authors.length === 0 &&
    (adoption.excludeTrusted === true || adoption.trusted.length === 0)
  )
    return "; dispatch.adopt names no author and the dispatcher's forge login does not read, so it adopts none";
  const adopted = drives.filter((d) => typeof d.evidence.adopted === "string");
  const who = [
    ...adoption.authors,
    ...adoption.trusted.map((login) =>
      adoption.excludeTrusted === true
        ? `${login} (trusted automation, manual drive)`
        : `${login} (trusted automation, same-repository only)`,
    ),
  ];
  return `; ${adopted.length} adopted by dispatch.adopt (authors ${who.join(", ")}, within ${shownWindow(adoption.withinMs)})`;
}

/** A window in the duration grammar the section takes (`168h`, `90m`, `30s`). */
function shownWindow(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  return `${Math.round(ms / 1000)}s`;
}

function botNote(author: Author, trusted: boolean): string {
  if (trusted) return " (a bot pull_requests.trusted_automation lists)";
  return isBot(author) ? " (a bot the rule names)" : "";
}

function eligibleAuthor(
  author: Author,
  adoption: Adoption,
  trusted: boolean,
): boolean {
  if (trusted) return true;
  const named = adoption.authors
    .map(normalLogin)
    .includes(normalLogin(author.login));
  return named && (!isBot(author) || adoption.named);
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
  if (adoption.initialAdoptionDisabled === true) return null;
  const author = pr.author;
  if (author === undefined || author.login === "") return null;
  if (labels !== null && hasCommand(labels, pr.labels, "hold")) return null;
  if (requiresManualTrustedDrive(author, adoption)) return null;
  const listed = trustedBot(author, adoption);
  const trusted = pr.isCrossRepository === false && listed;
  if (!eligibleAuthor(author, adoption, trusted)) return null;
  const updated = parseMs(pr.updatedAt ?? "");
  if (!Number.isFinite(updated) || nowMs - updated > adoption.withinMs)
    return null;
  const adopted = `dispatch.adopt: by ${author.login}${botNote(author, trusted)}, updated ${pr.updatedAt}, within its ${shownWindow(adoption.withinMs)} window`;
  if (!isAutomation(pr, adoption.authors)) return adopted;
  if (trusted)
    return `${adopted}; trusted automation, driven to convergence while healthy`;
  const trouble = troubleOf(pr);
  // Only trouble observed admits an automation pull request: a fact the forge did not give in full is unknown, not trouble.
  return trouble === null
    ? null
    : `${adopted}; an automation pull request that needs work: ${trouble}`;
}
