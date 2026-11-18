/** Find the workflows behind failing required checks of one releasing commit. */
import type { ReleasingCommit } from "../../skills/changelog/scripts/releasing-commit.ts";
import {
  mergeRequiredChecks,
  protectionContexts,
  type RequiredCheck,
  rulesetContexts,
} from "../../skills/drive-pr/scripts/lib/ci-policy.ts";
import { isRecord } from "../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";

type Read = (endpoint: string) => Promise<Outcome<unknown, "refused">>;
const refused = (why: string) => failed("refused", why);
const LIMIT = 100;

/** A configured list is exact. Otherwise both branch-protection sources count. */
async function required(
  read: Read,
  release: ReleasingCommit,
): Promise<
  Outcome<{ names: string[]; apps: Map<string, number[]> }, "refused">
> {
  if (release.checks !== undefined)
    return ok({ names: release.checks, apps: new Map() });
  const branch = encodeURIComponent(release.branch);
  const [classic, rules] = await Promise.all([
    read(`branches/${branch}`),
    read(`rules/branches/${branch}?per_page=${LIMIT}`),
  ]);
  if (!classic.ok) return classic;
  if (!rules.ok) return rules;
  const branchChecks = protectionContexts(classic.value);
  const rulesChecks =
    Array.isArray(rules.value) && rules.value.length < LIMIT
      ? rulesetContexts(rules.value)
      : null;
  if (branchChecks === null || rulesChecks === null)
    return refused("the required branch checks are unreadable or incomplete");
  const sources: RequiredCheck[][] = [branchChecks, rulesChecks];
  return ok(mergeRequiredChecks(sources));
}

function completeCollection(
  value: unknown,
  key: string,
): Record<string, unknown>[] | null {
  if (!isRecord(value)) return null;
  const rows = value[key];
  return Array.isArray(rows) &&
    rows.every(isRecord) &&
    value.total_count === rows.length &&
    rows.length <= LIMIT
    ? rows
    : null;
}

function id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** A skipped or neutral required check can still belong to a failed workflow. */
function needsWorkflowVerdict(
  check: Record<string, unknown>,
  { names, apps }: { names: string[]; apps: Map<string, number[]> },
): boolean {
  if (
    typeof check.name !== "string" ||
    !names.includes(check.name) ||
    check.status !== "completed" ||
    typeof check.conclusion !== "string" ||
    check.conclusion === "success"
  )
    return false;
  const pins = apps.get(check.name);
  return (
    pins === undefined ||
    (isRecord(check.app) && id(check.app.id) && pins.includes(check.app.id))
  );
}

async function failedGateSuites(
  read: Read,
  sha: string,
  gates: { names: string[]; apps: Map<string, number[]> },
): Promise<Outcome<Set<number>, "refused">> {
  const checks = await read(
    `commits/${sha}/check-runs?filter=latest&per_page=${LIMIT}`,
  );
  if (!checks.ok) return checks;
  const results = completeCollection(checks.value, "check_runs");
  if (results === null)
    return refused(
      "the releasing commit's check runs are unreadable or incomplete",
    );
  const suites = new Set<number>();
  for (const check of results) {
    if (!needsWorkflowVerdict(check, gates)) continue;
    if (
      check.head_sha !== sha ||
      !isRecord(check.check_suite) ||
      !id(check.check_suite.id)
    )
      return refused(
        "a failed gate did not name its check suite on the releasing commit",
      );
    suites.add(check.check_suite.id);
  }
  return ok(suites);
}

export async function failedGateRuns(
  read: Read,
  release: ReleasingCommit,
): Promise<Outcome<number[], "refused">> {
  const gates = await required(read, release);
  if (!gates.ok) return gates;
  if (gates.value.names.length === 0) return ok([]);
  const suites = await failedGateSuites(read, release.sha, gates.value);
  if (!suites.ok) return suites;
  if (suites.value.size === 0) return ok([]);
  const workflows = await read(
    `actions/runs?head_sha=${release.sha}&status=completed&per_page=${LIMIT}`,
  );
  if (!workflows.ok) return workflows;
  const runs = completeCollection(workflows.value, "workflow_runs");
  if (runs === null)
    return refused(
      "the releasing commit's workflow runs are unreadable or incomplete",
    );
  const found = new Set<number>();
  for (const run of runs) {
    if (!id(run.check_suite_id) || !suites.value.has(run.check_suite_id))
      continue;
    if (
      run.head_sha !== release.sha ||
      !id(run.id) ||
      typeof run.conclusion !== "string" ||
      run.conclusion === ""
    )
      return refused(
        "a failed gate's workflow run did not name an ID and conclusion on the releasing commit",
      );
    if (run.conclusion !== "success") found.add(run.id);
  }
  return ok([...found]);
}
