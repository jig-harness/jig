/** Extra opening facts derived from the PR's actual base and changed paths. */
import { Defect, JigError } from "../../../../shared/errors.ts";
import {
  areasOf,
  loadCatalogFile,
} from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import { changeAreasCatalogPath } from "../../../drive-pr/scripts/lib/overlay.ts";
import { git } from "../../../drive-pr/scripts/lib/proc.ts";

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

async function labelsForDiff(
  root: string,
  base: string,
  fixedLabels: string[],
): Promise<string[]> {
  const labels = new Set(fixedLabels);
  const catalogPath = changeAreasCatalogPath(root);
  if (catalogPath === undefined) return [...labels];
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
  for (const path of paths) {
    for (const key of areasOf(path, catalog)) {
      const area = catalog.get(key);
      if (area === undefined)
        throw new Defect(`matched area ${key} disappeared`);
      for (const label of [...area.trackerLabels, ...area.flags])
        labels.add(label);
    }
  }
  return [...labels];
}

export async function prDiffContext(
  root: string,
  base: string,
  fixedLabels: string[],
): Promise<{ labels: string[]; warnings: string[] }> {
  const warnings = await foreignMergeWarnings(root, base);
  const labels = await labelsForDiff(root, base, fixedLabels);
  return { labels, warnings };
}
