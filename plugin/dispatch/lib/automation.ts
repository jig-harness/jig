/**
 * Automation pull requests: the ones a workflow or a bot opens (a
 * regeneration, a sync, a dependency update) rather than a person.
 *
 * A pull request is one when it carries the `automation:` family's labels,
 * which a repository's workflows apply to say which job opened it
 * (`automation:docs-sync`), or the generic `automation` label, or when a bot
 * opened it that is not one of the host's own authors (`own`: the adoption
 * rule's authors, by default the login the dispatcher reads the forge as),
 * whose pull requests are the host's own work. The dispatcher puts
 * `automation` on such a bot's pull request that carries no label of the
 * family, and never removes a label of either kind; a person's pull request
 * never gets one from it.
 *
 * The dispatcher drives an automation pull request only while it needs
 * work (`troubleOf`): a check that failed, a conflict with its base, or a
 * review thread left unresolved. That holds for its adoption and for every
 * re-drive, takeover and re-arm the dispatcher would start of itself; a
 * person's `drive` or `rearm` label still starts one. A healthy one is left
 * for a person to merge. A check cancelled (a run on a superseded head) or
 * waiting for approval is not a failure. A check that failed on the CI
 * service's infrastructure is not told apart here: the drive it starts
 * re-runs such a check rather than repairing code.
 */
import { isRecord } from "../../shared/guards.ts";
import type { Author } from "./adopt.ts";
import type { DrivenPr, LedgerClass } from "./types.ts";

/** The generic label the dispatcher puts on a bot's pull request. */
export const AUTOMATION_LABEL = "automation";

/** The family a repository's workflows label their pull requests with. */
const AUTOMATION_PREFIX = "automation:";

/** How `jig install dispatch --repo` creates the generic label. */
export const AUTOMATION_SPEC = {
  name: AUTOMATION_LABEL,
  color: "ededed",
  description:
    "Opened by a bot or a workflow: the dispatcher drives it only when it needs work",
};

/** Whether an author is a bot: the forge says so, or its login is an app's. */
export function isBot(author: Author): boolean {
  const login = author.login.toLowerCase();
  return author.bot || login.endsWith("[bot]") || login.startsWith("app/");
}

/** A login as the adoption rule compares it: case folded, and a GitHub App's `app/<name>` as its `<name>[bot]` account. */
export function normalLogin(login: string): string {
  const folded = login.trim().toLowerCase();
  return folded.startsWith("app/") ? `${folded.slice(4)}[bot]` : folded;
}

/** Whether a bot not among the host's own authors opened the pull request. */
function foreignBot(
  author: Author | undefined,
  own: readonly string[],
): boolean {
  if (author === undefined || !isBot(author)) return false;
  const login = normalLogin(author.login);
  return !own.some((a) => normalLogin(a) === login);
}

/** Whether labels include `automation` or one of the `automation:` family. */
function automationLabelled(labels: readonly string[]): boolean {
  return labels.some(
    (l) => l === AUTOMATION_LABEL || l.startsWith(AUTOMATION_PREFIX),
  );
}

/** Whether a pull request is an automation pull request, by its labels or its author; `own` are the host's own authors. */
export function isAutomation(
  pr: { author?: Author; labels?: readonly string[] },
  own: readonly string[],
): boolean {
  return automationLabelled(pr.labels ?? []) || foreignBot(pr.author, own);
}

/** Whether the dispatcher puts `automation` on a pull request: a bot not among `own` opened it and it carries no label of the family. */
export function wantsAutomationLabel(
  pr: { author?: Author; labels?: readonly string[] },
  own: readonly string[],
): boolean {
  return foreignBot(pr.author, own) && !automationLabelled(pr.labels ?? []);
}

/** What the forge reports of an open pull request that says it needs work. */
export interface TroubleFacts {
  /** `CONFLICTING` when it conflicts with its base. */
  mergeable?: string;
  /** Whether a check on its head failed; absent when its checks were not read. */
  failingChecks?: boolean;
  /** Its unresolved review threads; absent when they were not read. */
  unresolvedThreads?: number;
}

/** Why an open pull request needs work, in words for the report; `null` when nothing read says it does. */
export function troubleOf(pr: TroubleFacts): string | null {
  const why: string[] = [];
  if (pr.failingChecks === true) why.push("a check on its head fails");
  if (pr.mergeable === "CONFLICTING") why.push("it conflicts with its base");
  const threads = pr.unresolvedThreads ?? 0;
  if (threads > 0)
    why.push(`${threads} review thread${threads === 1 ? "" : "s"} unresolved`);
  return why.length === 0 ? null : why.join(", ");
}

/**
 * The conclusions of a check run, and the states of a status, that failed.
 * A cancelled run (one on a superseded head) and one waiting for a person's
 * approval did not.
 */
const FAILED = new Set(["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"]);

/**
 * Whether a head's checks include one that failed, from the list of checks
 * the forge gives (each a run's `conclusion` or a status's `state`);
 * `undefined` when it does not read.
 */
export function checksFail(checks: unknown): boolean | undefined {
  if (!Array.isArray(checks)) return undefined;
  return checks.some(
    (c) =>
      isRecord(c) &&
      (FAILED.has(String(c.conclusion)) || FAILED.has(String(c.state))),
  );
}

/** A pull request a drive's ledger reads: whether it is an automation pull request with no trouble observed, which the dispatcher then starts no drive on of itself; a fact the forge did not give is no trouble observed. */
export function idleAutomation(
  pr: TroubleFacts & { author?: Author; labels?: readonly string[] },
  own: readonly string[],
): { automationIdle?: true } {
  return isAutomation(pr, own) && troubleOf(pr) === null
    ? { automationIdle: true }
    : {};
}

/** The classes the dispatcher starts a drive from of itself: a re-drive, a takeover, a re-arm. */
const AUTOMATIC: ReadonlySet<LedgerClass> = new Set([
  "stale",
  "silent",
  "re-armable",
]);

/** The classes a pending launch may still replay from: the automatic ones, and a park a pending conflict repair replays through. */
const REPLAYED: ReadonlySet<LedgerClass> = new Set([...AUTOMATIC, "parked"]);

/** Whether a drive's pull request is an automation pull request that needs no work, so that no drive is started on it of itself; a person's rearm request still starts one. */
export function idleBlocksStart(pr: DrivenPr, replay = false): boolean {
  return (
    pr.evidence.automationIdle === true &&
    pr.evidence.rearm !== true &&
    (replay ? REPLAYED : AUTOMATIC).has(pr.class)
  );
}
