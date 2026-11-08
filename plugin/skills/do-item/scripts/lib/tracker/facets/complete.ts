/**
 * The filing check (design/tracker-facets.md, "Checked inside the write"):
 * a new issue carries a type, a priority (1 to 4) and a size, for each facet
 * the repository has, with no size asked of an issue carrying the epic
 * label, and a label of every other required group of its label taxonomy
 * (file-issue's label check), the size group's requirement being met by the
 * size facet wherever it is kept.
 *
 * It runs inside the tracker `openTracker()` returns, so every caller of
 * `createIssue` gets it. In this release an incomplete issue is filed and
 * what it lacks is printed; the next release refuses it.
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
import type { NewIssue, Tracker } from "../port.ts";
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
  return existsSync(path) ? lintTaxonomyFile(path).taxonomy : null;
}

/** The warning an incomplete filing prints. */
export function incompleteWarning(key: string, missing: string[]): string {
  const named = missing.map((m) =>
    ["type", "priority", "size"].includes(m) ? m : `a ${m} label`,
  );
  return `warning: ${key} was filed without ${named.join(", ")}; the next release refuses an issue filed without them, so give each when filing (tracker.ts create takes "type", "priority" 1 to 4, and "size")`;
}

/** `tracker` with every `createIssue` checked: an incomplete issue is filed, and `warn` told what it lacks. */
export function checkedTracker(
  tracker: Tracker,
  facets: Facets,
  taxonomy: Taxonomy | null,
  warn: (message: string) => void,
): Tracker {
  return {
    ...tracker,
    async createIssue(issue) {
      const missing = incompleteness(issue, facets, taxonomy);
      const filed = await tracker.createIssue(issue);
      if (missing.length > 0)
        warn(incompleteWarning(filed.identifier, missing));
      return filed;
    },
  };
}
