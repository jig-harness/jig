/**
 * Whether the pull-request policy fits what the forge shows: the labels it
 * adds exist (`label-fit.ts`) and each base `pull_requests.base_rules` names
 * is a branch of the repository. And, offline, whether
 * `pull_requests.trusted_automation` can do anything in this configuration.
 */
import { ghJson } from "../../../../shared/detect.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { trustedAutomationOf } from "../../../drive-pr/scripts/lib/trusted-automation.ts";
import { labelFindings } from "./label-fit.ts";
import { at, type Finding } from "./schema.ts";

type Config = Record<string, unknown>;

/** Each base a rule names that the repository does not have, a warning: the planner refuses an item that rule chooses. */
async function baseRuleFindings(
  config: Config,
  root: string,
  slug: string,
): Promise<Finding[]> {
  const rules = at(config, "pull_requests.base_rules");
  if (!Array.isArray(rules)) return [];
  const findings: Finding[] = [];
  for (const [i, rule] of rules.entries()) {
    const base = isRecord(rule) ? rule.base : undefined;
    if (typeof base !== "string") continue;
    const branch = await ghJson(
      ["api", `repos/${slug}/branches/${encodeURIComponent(base)}`],
      root,
    );
    if (branch.ok) continue;
    findings.push(
      /HTTP 404|Not Found/i.test(branch.reason)
        ? {
            id: `derivation:pull_requests.base_rules:${base}`,
            severity: "warning",
            message: `pull_requests.base_rules[${i}] names ${base}, which does not exist in ${slug}: pr-plan.ts refuses to open an item that rule chooses until it does`,
          }
        : {
            id: `unchecked:pull_requests.base_rules:${base}`,
            severity: "info",
            message: `whether ${slug} has ${base}, which pull_requests.base_rules[${i}] names, could not be read`,
          },
    );
  }
  return findings;
}

/** What the forge shows of the pull-request policy: labels and bases. */
export async function policyFindings(
  config: Config,
  root: string,
  slug: string,
): Promise<Finding[]> {
  return [
    ...(await labelFindings(config, root, slug)),
    ...(await baseRuleFindings(config, root, slug)),
  ];
}

/**
 * What `pull_requests.trusted_automation` does in this configuration: a list
 * that does not read trusts nobody; with no `review.reviewer_app` a person's
 * approval is still the review witness, so the list changes no placement;
 * and with `dispatch.adopt` off a listed bot's healthy pull request is never
 * driven, so it reaches the board only on a person's `drive` label.
 */
export function trustedFit(config: Config): Finding[] {
  if (at(config, "pull_requests.trusted_automation") === undefined) return [];
  const list = trustedAutomationOf(config);
  if (!list.ok)
    return [
      {
        id: "rule:pull_requests.trusted_automation",
        severity: "error",
        message: `${list.failure.reason}: every bot's pull request stays in approve first`,
      },
    ];
  if (list.value.length === 0) return [];
  const findings: Finding[] = [];
  const app = at(config, "review.reviewer_app");
  if (typeof app !== "string" || app.trim() === "")
    findings.push({
      id: "derivation:pull_requests.trusted_automation:witness",
      severity: "warning",
      message:
        "pull_requests.trusted_automation changes nothing without review.reviewer_app: a person's approval is then the witness of every review, so a listed bot's pull request still waits in approve first",
    });
  if (at(config, "dispatch.adopt.enabled") !== true)
    findings.push({
      id: "derivation:pull_requests.trusted_automation:adopt",
      severity: "info",
      message:
        "dispatch.adopt is off, so a listed bot's healthy pull request is not driven and reaches Ready to merge only once a person labels it drive",
    });
  return findings;
}
