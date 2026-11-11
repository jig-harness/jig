/**
 * A CI service that reports through GitHub's commit statuses rather than
 * check runs (Jenkins through its GitHub Branch Source plugin, for one): how a
 * status is read, and the repository's two values that let a CI repair reach
 * its log. `drive-pr` reads the statuses into its CI verdict and tells a
 * repair pass which failed; `fix-ci` fetches each failed status's log.
 */

import { configSource, readConfig } from "./consumer.ts";
import { swallow } from "./errors.ts";
import { failed, type Outcome, ok } from "./outcome.ts";

/** One commit status context, as the newest status the head carries for it. */
export interface CommitStatus {
  context: string;
  state: string;
  description: string | null;
  /** The page the CI service links the status to (its build); absent or `null` when it names none. */
  targetUrl?: string | null;
}

/** A failing status as a repair is told it, in the form `ci.log_command` reads. */
export interface FailingStatus {
  context: string;
  target_url: string | null;
}

/**
 * A description that says the build was stopped before it finished. A CI
 * service with no cancelled state reports an aborted build as `error`
 * (Jenkins: "The build of this commit was aborted"), which is no evidence
 * about the code, the way a cancelled check run is none.
 */
const ABORTED = /\b(?:aborted|cancell?ed)\b/iu;

/** A status that says the build was aborted: read as cancelled, never as a failure. */
export function isAbortedStatus(status: CommitStatus): boolean {
  return status.state === "error" && ABORTED.test(status.description ?? "");
}

/** A finished status that is neither a success nor an aborted build. */
export function isFailingStatus(status: CommitStatus): boolean {
  return (
    status.state !== "success" &&
    status.state !== "pending" &&
    !isAbortedStatus(status)
  );
}

/** A failing status as a repair is told it. */
export function failingStatus(status: CommitStatus): FailingStatus {
  return { context: status.context, target_url: status.targetUrl ?? null };
}

/** One status of a combined-status page; `null` when it is not an object. */
function commitStatusOf(s: unknown): CommitStatus | null {
  if (s === null || typeof s !== "object" || Array.isArray(s)) return null;
  const status = s as Record<string, unknown>;
  return {
    context: String(status.context ?? ""),
    state: String(status.state ?? ""),
    description:
      status.description === null ? null : String(status.description ?? ""),
    targetUrl: typeof status.target_url === "string" ? status.target_url : null,
  };
}

/**
 * The statuses of `gh api --paginate --slurp …/commits/<sha>/status`, every
 * page; `null` when the output is not that shape.
 */
export function combinedStatuses(raw: string): CommitStatus[] | null {
  let pages: unknown;
  try {
    pages = JSON.parse(raw);
  } catch (err) {
    swallow(
      err,
      "the commit statuses are not JSON: the caller reads them as unread",
    );
    return null;
  }
  const statuses: CommitStatus[] = [];
  for (const page of Array.isArray(pages) ? pages : [pages]) {
    const list = (page as { statuses?: unknown } | null)?.statuses;
    if (!Array.isArray(list)) return null;
    for (const s of list) {
      const status = commitStatusOf(s);
      if (status === null) return null;
      statuses.push(status);
    }
  }
  return statuses;
}

/** `ci.log_command` and `ci.repair_skill`, each `undefined` when unset. */
export interface CiRepairSettings {
  /** Reads `{context, target_url}` as JSON on stdin, prints the status's failed log. */
  logCommand: string | undefined;
  /** The skill a CI-repair pass loads before it repairs. */
  repairSkill: string | undefined;
}

/** A skill name, bare or with its plugin (`ci-support`, `jig:fix-ci`). */
export const SKILL_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/u;

/**
 * Read `ci.log_command` and `ci.repair_skill` from the merged configuration;
 * a wrong-typed value is a failure naming where it was set.
 */
export function ciRepairSettings(
  config: Record<string, unknown> = readConfig(),
  sourceOf: (field: string) => string = configSource,
): Outcome<CiRepairSettings, "invalid-config"> {
  const ci = config.ci;
  if (ci === undefined || ci === null)
    return ok({ logCommand: undefined, repairSkill: undefined });
  if (typeof ci !== "object" || Array.isArray(ci))
    return failed("invalid-config", `ci must be a mapping: ${sourceOf("ci")}`);
  const { log_command: logCommand, repair_skill: repairSkill } = ci as Record<
    string,
    unknown
  >;
  if (
    logCommand !== undefined &&
    logCommand !== null &&
    (typeof logCommand !== "string" || logCommand.trim() === "")
  )
    return failed(
      "invalid-config",
      `ci.log_command must be a nonempty shell command: ${sourceOf("ci.log_command")}`,
    );
  if (
    repairSkill !== undefined &&
    repairSkill !== null &&
    (typeof repairSkill !== "string" || !SKILL_NAME_PATTERN.test(repairSkill))
  )
    return failed(
      "invalid-config",
      `ci.repair_skill must be a skill name, such as ci-support or plugin:skill: ${sourceOf("ci.repair_skill")}`,
    );
  return ok({
    logCommand: typeof logCommand === "string" ? logCommand : undefined,
    repairSkill: typeof repairSkill === "string" ? repairSkill : undefined,
  });
}
