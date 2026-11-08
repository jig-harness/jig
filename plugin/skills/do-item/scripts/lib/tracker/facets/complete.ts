/**
 * The filing check (design/tracker-facets.md, "Checked inside the write"):
 * a new issue carries a type, a priority (1 to 4) and a size, for each facet
 * the repository has, with no size asked of an issue carrying the epic
 * label, and a label of every other required group of its label taxonomy
 * (file-issue's label check), the size group's requirement being met by the
 * size facet wherever it is kept.
 *
 * It runs inside the tracker `openTracker()` returns, so every caller of
 * `createIssue` gets it: an incomplete issue is refused before anything is
 * written, naming what it lacks.
 */

import { existsSync } from "node:fs";
import { taxonomyAt } from "../../../../../file-issue/scripts/lib/config.ts";
import {
  lintTaxonomyFile,
  type Taxonomy,
} from "../../../../../file-issue/scripts/lib/taxonomy.ts";
import {
  missingGroups,
  SIZE_GROUP,
} from "../../../../../file-issue/scripts/lib/validate.ts";
import { type NewIssue, type Tracker, TrackerRequestError } from "../port.ts";
import { type Facets, usable } from "./config.ts";
import { fold } from "./values.ts";

/**
 * What a new issue lacks: `type`, `priority` and `size` for the facets the
 * repository has, then the id of each other required taxonomy group it
 * carries no label of.
 */
export function incompleteness(
  issue: NewIssue,
  facets: Facets,
  taxonomy: Taxonomy | null,
): string[] {
  const missing: string[] = [];
  if (usable(facets.type) && (issue.type ?? "").trim() === "")
    missing.push("type");
  if ((issue.priority ?? 0) === 0) missing.push("priority");
  const epic = issue.labels.some((l) => fold(l) === fold(facets.epic));
  if (usable(facets.size) && !epic && (issue.size ?? "").trim() === "")
    missing.push("size");
  if (taxonomy !== null)
    missing.push(...missingGroups(issue.labels, taxonomy, [SIZE_GROUP]));
  return missing;
}

/** The repository's label taxonomy, or `null` when it has none or it fails its lint. */
export function readTaxonomy(root: string, setting: string): Taxonomy | null {
  const path = taxonomyAt(root, setting);
  if (!existsSync(path)) return null;
  const result = lintTaxonomyFile(path);
  if (result.taxonomy === null)
    throw new TrackerRequestError(
      "invalid",
      "the label taxonomy failed lint; repair it before filing",
    );
  return result.taxonomy;
}

/** "a, b and c". */
function listed(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Why an incomplete filing is refused, naming what it lacks. */
export function incompleteRefusal(missing: string[]): string {
  const facets = missing.filter((m) =>
    ["type", "priority", "size"].includes(m),
  );
  const groups = missing.filter((m) => !facets.includes(m));
  const named = [
    ...facets.map((f) => `no ${f}`),
    ...groups.map((g) => `no ${g} label`),
  ];
  const how = [
    facets.length > 0
      ? `"type", "priority" (1 to 4) and "size" in the issue tracker.ts create reads (an epic needs no size)`
      : "",
    groups.length > 0
      ? "a label of each required group of the label taxonomy"
      : "",
  ].filter((s) => s !== "");
  return `refused to file an issue with ${listed(named)}: every issue is filed with its type, priority and size, so give ${listed(how)}`;
}

/** `tracker` with every `createIssue` checked: an incomplete issue is refused before anything is written. */
export function checkedTracker(
  tracker: Tracker,
  facets: Facets,
  taxonomy: Taxonomy | null,
): Tracker {
  return {
    ...tracker,
    async createIssue(issue) {
      const problems = [facets.type, facets.priority, facets.size].flatMap(
        (f) => (usable(f) || f.problem === null ? [] : [f.problem]),
      );
      if (problems.length > 0)
        throw new TrackerRequestError("invalid", problems.join("; "));
      const missing = incompleteness(issue, facets, taxonomy);
      if (missing.length > 0)
        throw new TrackerRequestError("invalid", incompleteRefusal(missing));
      return tracker.createIssue(issue);
    },
  };
}
