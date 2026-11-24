/**
 * Whether the pull-request policy fits what the forge shows: the labels it
 * adds exist (`label-fit.ts`) and each base `pull_requests.base_rules` names
 * is a branch of the repository. And, offline, whether
 * `pull_requests.trusted_automation` can do anything in this configuration.
 */
import { ghJson } from "../../../../shared/detect.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { dispatchSection } from "../../../../dispatch/lib/section.ts";
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
 * approval is still the review witness, so the list changes no approval
 * requirement; and when adoption or its trusted-bot rule is off, a
 * listed bot's pull request with no ledger is not adopted by its author;
 * with only author-based adoption off, a person's label (where labels are
 * on), a hand-armed drive or an eligible pickup handoff can still start its
 * first drive; with the explicit opt-out, no automatic start is left: a
 * person starts every listed bot's drive, directly.
 */
export function trustedFit(config: Config): Finding[] {
  if (at(config, "pull_requests.trusted_automation") === undefined) return [];
  const list = trustedAutomationOf(config);
  if (!list.ok)
    return [
      {
        id: "rule:pull_requests.trusted_automation",
        severity: "error",
        message: `${list.failure.reason}. The trusted automation exception is disabled.`,
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
        "pull_requests.trusted_automation does not change the approval requirement for merge now without review.reviewer_app: a person's approval is then the witness of every review and also satisfies the author condition",
    });
  const dispatch = dispatchSection(config);
  if (!dispatch.ok) return findings;
  const { adopt, labels } = dispatch.value;
  if (adopt.excludeTrusted === true)
    findings.push({
      id: "derivation:pull_requests.trusted_automation:adopt",
      severity: "info",
      message: `dispatch.adopt.trusted_automation is false: no automatic start is left for a listed bot's pull request. Its first drive, a restart after a head that moved and a conflict repair all wait for a person, and a pickup handoff cannot start it. Review the install inputs (manifests, installer configuration, lockfiles) against a trusted baseline, then start the drive directly from a verified checkout${
        labels.enabled
          ? ". A drive or rearm label is not a substitute: it pins neither the reviewed head nor the base the drive merges, and a rearm label needs a trusted request bound to an eligible stop, so the dispatcher may start from inputs nobody reviewed"
          : " (dispatch.labels.enabled is off, so there is no label route)"
      }. A drive a person stopped stays stopped.`,
    });
  else if (!adopt.enabled)
    findings.push({
      id: "derivation:pull_requests.trusted_automation:adopt",
      severity: "info",
      message:
        "Author-based adoption is off, so a listed bot's pull request with no ledger is not adopted by its author; a person can still label it drive (where dispatch.labels.enabled is on) or arm a drive by hand. A completed process pickup can still start the first drive of its own same-repository pull request, and a drive that stopped in an eligible state can restart from its ledger. Set dispatch.adopt.trusted_automation: false to require a person to start every listed bot's drive, and review its install inputs first.",
    });
  return findings;
}
