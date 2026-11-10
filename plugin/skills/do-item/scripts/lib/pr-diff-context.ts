/** Extra opening facts derived from the PR's actual base and changed paths. */
import { Defect, JigError } from "../../../../shared/errors.ts";
import {
  areasOf,
  type ChangeAreaCatalog,
  loadCatalogFile,
} from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import { changeAreasCatalogPath } from "../../../drive-pr/scripts/lib/overlay.ts";
import { git } from "../../../drive-pr/scripts/lib/proc.ts";
import { REVIEWER, reviewerArg } from "../../../../shared/forge-logins.ts";

/** Read failures stop planning rather than hide a foreign merge or an area's labels. */
async function output(root: string, args: string[]): Promise<string> {
  const result = await git(["-C", root, ...args], { stderr: "pipe" });
  if (result.code !== 0)
    throw new JigError(
      "pr-diff-unreadable",
      `git ${args.join(" ")} failed: ${result.stderrTail}`,
    );
  return result.stdout;
}

async function foreignCommits(
  root: string,
  base: string,
  first: string,
  parent: string,
): Promise<string> {
  const ancestry = await git(
    ["-C", root, "merge-base", "--is-ancestor", parent, base],
    { stderr: "pipe" },
  );
  if (ancestry.code === 0) return "";
  if (ancestry.code !== 1)
    throw new JigError(
      "pr-diff-unreadable",
      `could not check merge ancestry for ${parent}: ${ancestry.stderrTail}`,
    );
  return (
    await output(root, ["log", "--format=%h %s", parent, "--not", base, first])
  ).trim();
}

async function foreignMergeWarnings(
  root: string,
  base: string,
): Promise<string[]> {
  const warnings: string[] = [];
  const merges = await output(root, [
    "rev-list",
    "--merges",
    "--parents",
    `${base}..HEAD`,
  ]);
  for (const line of merges.trim().split("\n").filter(Boolean)) {
    const [merge, first, ...others] = line.split(" ");
    if (merge === undefined || first === undefined)
      throw new Defect("git returned a malformed merge row");
    for (const parent of others) {
      const commits = await foreignCommits(root, base, first, parent);
      if (commits !== "")
        warnings.push(
          `foreign merge ${merge}: commits brought in from ${parent} outside ${base}:\n${commits}`,
        );
    }
  }
  return warnings;
}

/** A label or reviewer the pull request opens with, and where it came from. */
export interface Signal {
  value: string;
  /** `issue label <label>` or `area <key>`. */
  from: string;
}

/** An area's `pr` block: the labels and reviewers a pull request touching it opens with. */
export function areaPrSignals(
  key: string,
  fields: Readonly<Record<string, unknown>>,
): { labels: string[]; reviewers: string[] } {
  const raw = fields.pr;
  if (raw === undefined) return { labels: [], reviewers: [] };
  const at = `change area ${key}: pr`;
  const list = (v: unknown, what: string, ok: (x: string) => boolean) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !ok(x)))
      throw new JigError(
        "pr-area-malformed",
        `${at}.${what} must be a list of ${what === "labels" ? "label names" : "logins or org/team names"}`,
      );
    return v as string[];
  };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new JigError(
      "pr-area-malformed",
      `${at} must be a mapping of {labels, reviewers}`,
    );
  const block = raw as Record<string, unknown>;
  for (const k of Object.keys(block))
    if (k !== "labels" && k !== "reviewers")
      throw new JigError(
        "pr-area-malformed",
        `${at}.${k} is not a known field (labels, reviewers)`,
      );
  return {
    labels: list(block.labels, "labels", (x) => x.trim() !== ""),
    reviewers: list(block.reviewers, "reviewers", (x) => REVIEWER.test(x)).map(
      reviewerArg,
    ),
  };
}

async function labelsForDiff(
  root: string,
  base: string,
  fixedLabels: string[],
): Promise<{
  labels: string[];
  areaLabels: Signal[];
  areaReviewers: Signal[];
}> {
  const labels = new Set(fixedLabels);
  const catalogPath = changeAreasCatalogPath(root);
  if (catalogPath === undefined)
    return { labels: [...labels], areaLabels: [], areaReviewers: [] };
  const catalog = loadCatalogFile(catalogPath);
  const paths = (
    await output(root, [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      `${base}...HEAD`,
    ])
  )
    .split("\0")
    .filter(Boolean);
  const touched = new Set<string>();
  for (const path of paths) {
    for (const key of areasOf(path, catalog)) {
      const area = catalog.get(key);
      if (area === undefined)
        throw new Defect(`matched area ${key} disappeared`);
      for (const label of [...area.trackerLabels, ...area.flags])
        labels.add(label);
      touched.add(key);
    }
  }
  return { labels: [...labels], ...touchedAreaSignals(catalog, touched) };
}

/** The touched areas' `pr` labels and reviewers, in catalog order, so the plan reads the same whatever the diff's order. */
function touchedAreaSignals(
  catalog: ChangeAreaCatalog,
  touched: ReadonlySet<string>,
): { areaLabels: Signal[]; areaReviewers: Signal[] } {
  const areaLabels: Signal[] = [];
  const areaReviewers: Signal[] = [];
  for (const [key, area] of catalog) {
    if (!touched.has(key)) continue;
    const pr = areaPrSignals(key, area.fields);
    const from = `area ${key}`;
    areaLabels.push(...pr.labels.map((value) => ({ value, from })));
    areaReviewers.push(...pr.reviewers.map((value) => ({ value, from })));
  }
  return { areaLabels, areaReviewers };
}

export async function prDiffContext(
  root: string,
  base: string,
  fixedLabels: string[],
): Promise<{
  labels: string[];
  areaLabels: Signal[];
  areaReviewers: Signal[];
  warnings: string[];
}> {
  const warnings = await foreignMergeWarnings(root, base);
  const { labels, areaLabels, areaReviewers } = await labelsForDiff(
    root,
    base,
    fixedLabels,
  );
  return { labels, areaLabels, areaReviewers, warnings };
}
