/**
 * Whether the labels the pull-request policy adds exist in the repository:
 * `pull_requests.labels` and the labels `pull_requests.labels_from_issue`
 * maps an issue's labels to. `gh pr create` fails on a label the repository
 * does not have, so each missing one is an error.
 */
import { isMapping } from "../../../../shared/config-layers.ts";
import { ghJson, texts } from "../../../../shared/detect.ts";
import { at, type Finding } from "./schema.ts";

type Config = Record<string, unknown>;

/** Each label the policy adds, with the field that names it. */
export function policyLabels(config: Config): Array<[string, string]> {
  const fromIssue = at(config, "pull_requests.labels_from_issue");
  return [
    ...texts(at(config, "pull_requests.labels")).map((l): [string, string] => [
      l,
      "pull_requests.labels",
    ]),
    ...texts(isMapping(fromIssue) ? Object.values(fromIssue) : []).map(
      (l): [string, string] => [l, "pull_requests.labels_from_issue"],
    ),
  ];
}

/** The policy's labels missing from `names` (labels match in any case, as the planner matches them), each an error. */
export function missingLabelFindings(
  labels: ReadonlyArray<[string, string]>,
  names: ReadonlySet<string>,
  slug: string,
): Finding[] {
  const have = new Set([...names].map((n) => n.toLowerCase()));
  return labels
    .filter(([label]) => !have.has(label.toLowerCase()))
    .map(([label, field]) => ({
      id: `derivation:${field}:${label}`,
      severity: "error",
      message: `${field} names ${label}, which does not exist in ${slug}: opening a pull request fails`,
    }));
}

/** Configured pull-request labels the repository does not have. */
export async function labelFindings(
  config: Config,
  root: string,
  slug: string,
): Promise<Finding[]> {
  const labels = policyLabels(config);
  if (labels.length === 0) return [];
  const list = await ghJson(
    ["label", "list", "--limit", "1000", "--json", "name"],
    root,
  );
  if (!list.ok || !Array.isArray(list.value))
    return [
      {
        id: "unchecked:pull_requests.labels",
        severity: "info",
        message:
          "the repository's labels could not be read: whether the labels pull_requests names exist is unchecked",
      },
    ];
  const names = new Set((list.value as { name: string }[]).map((l) => l.name));
  return missingLabelFindings(labels, names, slug);
}
