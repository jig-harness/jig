/** GitHub branch controls and optional bot write access, through the shared read-only reader. */
import { isRecord } from "../../../../plugin/shared/guards.ts";
import {
  combine,
  contexts,
  documentOf,
  field,
  ghApi,
  readBranch,
  sourceOf,
  type GhApi,
  type Source,
} from "../../../../plugin/skills/changelog/scripts/github-rules.ts";
import { evaluateAccess } from "../../../../plugin/skills/changelog/scripts/release-access.ts";
import {
  PreconditionError,
  type Check,
  type Observation,
  type Precondition,
} from "./registry.ts";

interface Expected {
  required_checks?: string[];
  conversation_resolution?: boolean;
  force_pushes?: boolean;
  deletions?: boolean;
  pull_requests?: boolean;
  writer?: { app_id: number; slug?: string };
}
function expectedOf(entry: Precondition): Expected {
  const expected = entry.expected;
  const allowed = [
    "required_checks",
    "conversation_resolution",
    "force_pushes",
    "deletions",
    "pull_requests",
    "writer",
  ];
  if (!Object.keys(expected).length)
    throw new PreconditionError(
      "expected must name at least one branch control",
    );
  for (const key of Object.keys(expected))
    if (!allowed.includes(key))
      throw new PreconditionError(`unknown branch expected field: ${key}`);
  for (const key of [
    "conversation_resolution",
    "force_pushes",
    "deletions",
    "pull_requests",
  ])
    if (expected[key] !== undefined && typeof expected[key] !== "boolean")
      throw new PreconditionError(`${key} must be boolean`);
  validateChecks(expected.required_checks);
  validateWriter(expected.writer);
  return expected as Expected;
}
function validateChecks(checks: unknown): void {
  if (checks === undefined) return;
  if (
    !Array.isArray(checks) ||
    !checks.length ||
    !checks.every((check) => typeof check === "string" && check.trim())
  )
    throw new PreconditionError("required_checks must be nonempty check names");
}
function validateWriter(writer: unknown): void {
  if (writer === undefined) return;
  if (
    !isRecord(writer) ||
    !Number.isSafeInteger(writer.app_id) ||
    Number(writer.app_id) <= 0
  )
    throw new PreconditionError("writer needs a positive app_id");
  if (
    writer.slug !== undefined &&
    (typeof writer.slug !== "string" || !writer.slug.trim())
  )
    throw new PreconditionError("writer slug must be nonempty text");
  if (Object.keys(writer).some((key) => !["app_id", "slug"].includes(key)))
    throw new PreconditionError("writer contains unknown fields");
}
function targetOf(entry: Precondition): { repository: string; branch: string } {
  const { repository, branch } = entry.target;
  if (
    Object.keys(entry.target).some(
      (key) => !["repository", "branch"].includes(key),
    ) ||
    typeof repository !== "string" ||
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository) ||
    typeof branch !== "string" ||
    !branch.trim()
  )
    throw new PreconditionError(
      "branch target needs repository owner/repo and explicit branch",
    );
  return { repository, branch };
}
function evaluate(
  entry: Precondition,
  source: Source,
  expected: Expected,
): Observation {
  const value = combine(source);
  const results: Observation[] = [];
  const assert = (label: string, pass: boolean) =>
    results.push({
      status: pass ? "pass" : "fail",
      reasons: [
        `${label}: ${pass ? "satisfied" : "absent or differs from expected"}`,
      ],
    });
  if (source.classicUnknown)
    results.push({
      status: "unknown",
      reasons: [
        `classic protection ${source.classicUnknown === "unreadable" ? "access denied or withheld" : "branch missing; classic protection unknown"}`,
      ],
    });
  for (const check of expected.required_checks ?? [])
    assert(`required check ${check}`, contexts(value).includes(check));
  if (expected.conversation_resolution !== undefined)
    assert(
      "conversation resolution",
      field(value, "required_conversation_resolution.enabled") ===
        expected.conversation_resolution,
    );
  if (expected.force_pushes !== undefined)
    assert(
      "force pushes",
      field(value, "allow_force_pushes.enabled") === expected.force_pushes,
    );
  if (expected.deletions !== undefined)
    assert(
      "branch deletions",
      field(value, "allow_deletions.enabled") === expected.deletions,
    );
  if (expected.pull_requests !== undefined)
    assert(
      "pull requests required",
      isRecord(value.required_pull_request_reviews) === expected.pull_requests,
    );
  results.push(...writerObservations(entry, source, expected));
  return {
    status: results.some((r) => r.status === "unknown")
      ? "unknown"
      : results.some((r) => r.status === "fail")
        ? "fail"
        : "pass",
    reasons: results.flatMap((r) => r.reasons),
  };
}
function writerObservations(
  entry: Precondition,
  source: Source,
  expected: Expected,
): Observation[] {
  if (!expected.writer) return [];
  const target = targetOf(entry);
  const results: Observation[] = [];
  const report = evaluateAccess({
    mode: "direct",
    repo: target.repository,
    integrationBranch: target.branch,
    releaseBranch: "",
    identity: {
      id: expected.writer.app_id,
      slug: expected.writer.slug ?? null,
    },
    protection: { integration: source, releaseBranch: null },
  });
  const push = report.requirements.find(
    (requirement) => requirement.id === "push",
  );
  if (!push) throw new PreconditionError("writer push requirement missing");
  // Branch controls only: the installation's Contents write permission is not
  // observable read-only, and the writer's own token minting checks it.
  results.push({
    status: push.status,
    reasons: [
      ...push.reasons,
      "writer: judged on branch controls only; the installation's Contents write permission is not observed",
    ],
  });
  // Required safety controls must bind this writer as well as ordinary actors.
  for (const id of ["force-push-blocked", "deletion-blocked"] as const) {
    if (
      (id === "force-push-blocked"
        ? expected.force_pushes
        : expected.deletions) !== false
    )
      continue;
    const requirement = report.requirements.find((r) => r.id === id);
    if (!requirement)
      throw new PreconditionError(`writer ${id} requirement missing`);
    results.push({
      status: requirement.status,
      reasons: requirement.reasons,
    });
  }
  return results;
}
/** Inject gh for tests or another GitHub transport; fixture documents use github-rules' shape. */
export function branchProtection(gh: GhApi = ghApi()): Check {
  const check: Check = (entry, input) => {
    const expected = expectedOf(entry);
    const target = targetOf(entry);
    if (input !== undefined && !isRecord(input))
      throw new PreconditionError("branch fixture must be an object");
    const source =
      input === undefined
        ? readBranch(checkedGh(gh), target.repository, target.branch, {
            classicUnreadable: "unknown",
          })
        : sourceOf(input as Record<string, unknown>, true);
    const normalized = sourceOf(documentOf(source), true);
    validateSource(normalized);
    return evaluate(entry, normalized, expected);
  };
  check.validate = (entry) => {
    expectedOf(entry);
    targetOf(entry);
  };
  return check;
}

/** A successful classic endpoint must be an object; malformed is never absent. */
function checkedGh(gh: GhApi): GhApi {
  return (args) => {
    const result = gh(args);
    if (
      result.ok &&
      args[0]?.endsWith("/protection") &&
      !isRecord(JSON.parse(result.stdout))
    )
      throw new PreconditionError(
        "classic protection did not read as an object",
      );
    const path = args[0] ?? "";
    if (result.ok && /\/rulesets\/\d+$/.test(path))
      validateRulesetResponse(
        JSON.parse(result.stdout),
        path.split("/").at(-1) ?? "",
      );
    return result;
  };
}
function validateRulesetResponse(value: unknown, id: string): void {
  if (!isRecord(value) || String(value.id) !== id)
    throw new PreconditionError(
      "ruleset response identity does not match requested ruleset",
    );
  if (!["active", "evaluate", "disabled"].includes(String(value.enforcement)))
    throw new PreconditionError("ruleset response has invalid enforcement");
}

/** The actor types GitHub's ruleset API names; any other is an unknown bypass. */
const ACTOR_TYPES = [
  "Integration",
  "OrganizationAdmin",
  "RepositoryRole",
  "Team",
  "DeployKey",
  "User",
];
/**
 * Validated on every source, live or offline, so an observation handed over as
 * data meets the checks a live read does. A ruleset GitHub described (more
 * than its id) states its enforcement; a malformed identity or mode is never
 * coerced into an apparently empty bypass.
 */
function validateSource(source: Source): void {
  for (const ruleset of source.rulesets) {
    const described = Object.keys(ruleset).some((key) => key !== "id");
    if (
      described &&
      !["active", "evaluate", "disabled"].includes(String(ruleset.enforcement))
    )
      throw new PreconditionError(
        `ruleset ${String(ruleset.id)} has no valid enforcement`,
      );
    const actors = ruleset.bypass_actors;
    if (actors === undefined || actors === null) continue;
    if (!Array.isArray(actors))
      throw new PreconditionError("bypass_actors must be an array");
    for (const actor of actors) validateBypassActor(actor);
  }
}
function validateBypassActor(actor: unknown): void {
  if (!isRecord(actor))
    throw new PreconditionError("bypass actor must be an object");
  if (
    typeof actor.actor_type !== "string" ||
    !ACTOR_TYPES.includes(actor.actor_type)
  )
    throw new PreconditionError("bypass actor has an unknown actor_type");
  if (
    typeof actor.bypass_mode !== "string" ||
    !["always", "pull_request", "exempt"].includes(actor.bypass_mode)
  )
    throw new PreconditionError("bypass actor has invalid bypass_mode");
  if (
    (actor.actor_type === "DeployKey" ||
      actor.actor_type === "OrganizationAdmin") &&
    (actor.actor_id === null || actor.actor_id === undefined)
  )
    return;
  if (!Number.isSafeInteger(actor.actor_id) || Number(actor.actor_id) <= 0)
    throw new PreconditionError("bypass actor needs a positive actor_id");
}
