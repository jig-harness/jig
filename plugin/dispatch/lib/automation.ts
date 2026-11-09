/**
 * Automation pull requests: the ones a workflow or a bot opens (a
 * regeneration, a sync, a dependency update) rather than a person.
 *
 * A pull request is one when it carries the `automation:` family's labels,
 * which a repository's workflows apply to say which job opened it
 * (`automation:docs-sync`), or the generic `automation` label, or when a bot
 * opened it. The dispatcher puts `automation` on a bot's pull request that
 * carries no label of the family, and never removes a label of either kind;
 * a person's pull request never gets one from it.
 *
 * The adoption rule drives an automation pull request only while it needs
 * work (`troubleOf`): a check that fails, a conflict with its base, or a
 * review thread left unresolved. A healthy one is left for a person to
 * merge. A check that failed on the CI service's infrastructure is not told
 * apart here: the drive it starts re-runs such a check rather than repairing
 * code.
 */
import { isRecord } from "../../shared/guards.ts";
import type { Author } from "./adopt.ts";

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

/** Whether labels include `automation` or one of the `automation:` family. */
function automationLabelled(labels: readonly string[]): boolean {
  return labels.some(
    (l) => l === AUTOMATION_LABEL || l.startsWith(AUTOMATION_PREFIX),
  );
}

/** Whether a pull request is an automation pull request, by its labels or its author. */
export function isAutomation(pr: {
  author?: Author;
  labels?: readonly string[];
}): boolean {
  if (automationLabelled(pr.labels ?? [])) return true;
  return pr.author !== undefined && isBot(pr.author);
}

/** Whether the dispatcher puts `automation` on a pull request: a bot opened it and it carries no label of the family. */
export function wantsAutomationLabel(pr: {
  author?: Author;
  labels?: readonly string[];
}): boolean {
  return (
    pr.author !== undefined &&
    isBot(pr.author) &&
    !automationLabelled(pr.labels ?? [])
  );
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

/** The conclusions and states of a check that failed. */
const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

/**
 * Whether a head's checks include one that failed, from either shape the
 * forge gives them in: the listing's list of checks (each a run's
 * `conclusion` or a status's `state`), or the query's rollup (`{ state }`).
 * `undefined` when neither reads.
 */
export function checksFail(rollup: unknown): boolean | undefined {
  if (Array.isArray(rollup))
    return rollup.some(
      (c) =>
        isRecord(c) &&
        (FAILED.has(String(c.conclusion)) || FAILED.has(String(c.state))),
    );
  if (isRecord(rollup) && typeof rollup.state === "string")
    return FAILED.has(rollup.state);
  return undefined;
}
