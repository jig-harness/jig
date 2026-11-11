/**
 * Whether the pull-request policy fits what the forge shows: the labels it
 * adds exist (`label-fit.ts`), the recent merged titles follow
 * `pull_requests.title_pattern`, and each base `pull_requests.base_rules`
 * names is a branch of the repository.
 */
import { ghJson } from "../../../../shared/detect.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { matchesTitlePattern } from "../../../drive-pr/scripts/lib/pr-conventions.ts";
import { labelFindings } from "./label-fit.ts";
import { at, type Finding } from "./schema.ts";

type Config = Record<string, unknown>;

/** How many merged titles the pattern is checked against. */
export const TITLES_READ = 30;

/** Share of those titles that must follow the pattern before a mismatch is only information. */
export const TITLE_SHARE = 0.8;

/** Findings on how far `titles` follow `pattern`: none when all do. */
export function titlePatternFindings(
  pattern: string,
  titles: readonly string[],
): Finding[] {
  const off = titles.filter((t) => !matchesTitlePattern(pattern, t));
  if (off.length === 0) return [];
  const share = (titles.length - off.length) / titles.length;
  return [
    {
      id: "contradiction:pull_requests.title_pattern",
      severity: share >= TITLE_SHARE ? "info" : "warning",
      message: `${off.length} of the last ${titles.length} merged pull requests' titles do not follow pull_requests.title_pattern (${pattern}), such as ${off
        .slice(0, 3)
        .map((t) => JSON.stringify(t))
        .join(", ")}: correct the pattern, or title pull requests by it`,
    },
  ];
}

/** The pattern checked against the titles of the last merged pull requests into `base`. */
async function mergedTitleFindings(
  config: Config,
  root: string,
  base: string,
): Promise<Finding[]> {
  const pattern = at(config, "pull_requests.title_pattern");
  if (
    at(config, "pull_requests.title_format") !== "pattern" ||
    typeof pattern !== "string"
  )
    return [];
  const merged = await ghJson(
    [
      "pr",
      "list",
      "--state",
      "merged",
      "--base",
      base,
      "--limit",
      String(TITLES_READ),
      "--json",
      "title",
    ],
    root,
  );
  const titles =
    merged.ok && Array.isArray(merged.value)
      ? merged.value.flatMap((p) =>
          isRecord(p) && typeof p.title === "string" ? [p.title] : [],
        )
      : null;
  if (titles === null || titles.length === 0)
    return [
      {
        id: "unchecked:pull_requests.title_pattern",
        severity: "info",
        message:
          titles === null
            ? "the merged pull requests could not be read: whether their titles follow pull_requests.title_pattern is unchecked"
            : `no pull request has merged into ${base} yet: whether titles follow pull_requests.title_pattern is unchecked`,
      },
    ];
  return titlePatternFindings(pattern, titles);
}

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

/** What the forge shows of the pull-request policy: labels, titles and bases. */
export async function policyFindings(
  config: Config,
  root: string,
  slug: string,
  base: string,
): Promise<Finding[]> {
  return [
    ...(await labelFindings(config, root, slug)),
    ...(await mergedTitleFindings(config, root, base)),
    ...(await baseRuleFindings(config, root, slug)),
  ];
}
