/**
 * The labels a deferred finding is filed with: the `followup` role's label,
 * and a label of each other group the repository's label taxonomy requires
 * that can be derived with certainty. The filing check inside `createIssue`
 * (`do-item`'s `facets/complete.ts`) refuses an issue lacking one, so a group
 * left underived keeps the entry in the pull request's `## Deferred` section
 * for a person, naming the group.
 *
 * A group's label is derived the way `/jig:file-issue` derives labels: from
 * the tracker projection (`tracker.labels`) of the change-area catalog's seed
 * areas, the areas whose own globs match the file the finding is on, never
 * the areas they imply. Only a review thread is on a file; a summary finding
 * names none. A group is filled only when those areas carry exactly one of its
 * labels: none, or two that disagree, is no certainty, and nothing is guessed.
 * Labels are compared ignoring case, and the taxonomy's spelling is filed.
 * The size group is the size facet's, as the filing check reads it.
 */
import {
  areasOf,
  type ChangeAreaCatalog,
  loadCatalogFile,
} from "../../../drive-pr/scripts/lib/change-areas-catalog.ts";
import { changeAreasCatalogPath } from "../../../drive-pr/scripts/lib/overlay.ts";
import type { Taxonomy } from "../../../file-issue/scripts/lib/taxonomy.ts";
import {
  missingGroups,
  SIZE_GROUP,
} from "../../../file-issue/scripts/lib/validate.ts";

/** What a group's label is derived from: the catalog, or why there is none. */
export type CatalogSource =
  | { catalog: ChangeAreaCatalog }
  | { catalog: null; why: string };

/** "a, b and c". */
function listed(items: string[]): string {
  return items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The required groups, the size group aside, an issue carrying only `label` has no label of. */
export function unfilledGroups(
  label: string,
  taxonomy: Taxonomy | null,
): string[] {
  return taxonomy === null
    ? []
    : missingGroups([label], taxonomy, [SIZE_GROUP]);
}

/** The file a finding is on, or why it is on none. */
export type FindingFile = { path: string } | { none: string };

/**
 * The labels an entry on `file` is filed with, or why a person files it:
 * `label`, then the one label the file's seed areas carry of each required
 * group `label` leaves unfilled, compared ignoring case and spelt as the
 * taxonomy spells it. With no taxonomy, or none of its required groups
 * unfilled, `label` alone, and the catalog is not read.
 */
export function entryLabels(
  label: string,
  file: FindingFile,
  taxonomy: Taxonomy | null,
  catalog: () => CatalogSource,
): { labels: string[] } | { why: string } {
  const missing = unfilledGroups(label, taxonomy);
  if (taxonomy === null || missing.length === 0) return { labels: [label] };
  const lacks = `it lacks a ${listed(missing)} label`;
  if ("none" in file)
    return {
      why: `${lacks}, which is derived only from the file a review thread is on: ${file.none}`,
    };
  const { path } = file;
  const source = catalog();
  if (source.catalog === null) return { why: `${lacks}: ${source.why}` };
  const areas = areasOf(path, source.catalog);
  if (areas.length === 0)
    return {
      why: `${lacks}: no area of the change-area catalog covers ${path}`,
    };
  const projected = new Set(
    areas.flatMap((a) =>
      (source.catalog.get(a)?.trackerLabels ?? []).map((l) => l.toLowerCase()),
    ),
  );
  const labels = [label];
  for (const id of missing) {
    const group = taxonomy.groups.find((g) => g.id === id);
    const found = (group?.labels ?? []).filter((l) =>
      projected.has(l.toLowerCase()),
    );
    if (found.length !== 1)
      return {
        why:
          found.length === 0
            ? `it lacks a ${id} label: no area covering ${path} (${listed(areas)}) carries one`
            : `it lacks a ${id} label: the areas covering ${path} carry more than one (${listed(found)})`,
      };
    labels.push(found[0] as string);
  }
  return { labels };
}

/** The consumer's change-area catalog (`drive.change_areas_catalog`), or why none is read. */
export function configuredCatalog(): CatalogSource {
  let path: string | undefined;
  try {
    path = changeAreasCatalogPath();
  } catch (err) {
    return { catalog: null, why: message(err) };
  }
  if (path === undefined)
    return {
      catalog: null,
      why: "the repository sets no change-area catalog (drive.change_areas_catalog)",
    };
  try {
    return { catalog: loadCatalogFile(path) };
  } catch (err) {
    return {
      catalog: null,
      why: `the change-area catalog cannot be used; repair it, then run again: ${message(err)}`,
    };
  }
}

const message = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);
