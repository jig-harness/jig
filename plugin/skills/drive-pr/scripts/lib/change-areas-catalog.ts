/**
 * The plugin's one reader of the consumer's change-area catalog
 * (`drive.change_areas_catalog`): a YAML file whose `areas` map names each
 * area of the repository by key. Every skill that reads the catalog imports
 * this module by sibling path; a path glob is matched by `shared/glob.ts`.
 *
 * It reads the part of the catalog the plugin acts on:
 *
 *   areas:
 *     <area key>:
 *       paths: ["src/api/**"]          # globs that define membership
 *       generated: [{ source: [...] }] # optional: generator sources, also members
 *       labels: [delivery]             # optional: the area's own labels
 *       tracker:                       # optional; `linear:` is the older spelling
 *         labels: [area:api]           #   tracker labels for the area
 *         flags: [security]            #   flag labels every change there carries
 *       serialize: true                # optional: the dispatcher drives the pull
 *                                      #   requests that touch it one at a time
 *
 * Matching is direct: a path belongs to the areas whose own globs match it.
 * The areas a change implies through other areas are the full resolver's
 * business, not this reader's. Every other field stays available as written
 * (`fields`), for the consumer's own tooling and for skills that read one
 * more field, such as `agent`, `implementation` (do-item's guidance) or
 * `pr` (its pull-request planner).
 */
import { readFileSync } from "node:fs";
import { load as loadYaml } from "../../../../shared/yaml.ts";
import { globProblem, matchesGlob } from "../../../../shared/glob.ts";
import { isRecord } from "../../../../shared/guards.ts";

export interface CatalogArea {
  /** `paths` and every `generated[].source`, in that order. */
  globs: string[];
  /** `labels`, then `trackerLabels`. */
  labels: string[];
  /** `tracker.labels`, then `linear.labels`. */
  trackerLabels: string[];
  /** `tracker.flags`, then `linear.flags`. */
  flags: string[];
  /** `serialize`: the pull requests that touch the area are driven one at a time; `false` when absent. */
  serialize: boolean;
  /** The area as the catalog writes it. */
  fields: Readonly<Record<string, unknown>>;
}

/** The catalog's areas by key, in the catalog's order. */
export type ChangeAreaCatalog = ReadonlyMap<string, CatalogArea>;

// Only an omitted field reads as empty. A present one, `null` included, must
// have its shape: read as empty, a malformed area would silently drop its
// paths, its labels or its flags.
function stringList(v: unknown, where: string): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
    throw new Error(`${where}: expected a list of strings`);
  return v as string[];
}

// A list of globs, each compiled: a bad one is named by its field and index.
function globList(v: unknown, where: string): string[] {
  const globs = stringList(v, where);
  globs.forEach((glob, i) => {
    const problem = globProblem(glob);
    if (problem !== null) throw new Error(`${where}[${i}]: ${problem}`);
  });
  return globs;
}

// The tracker block in both spellings, each checked for its shape.
const TRACKER_BLOCKS = ["tracker", "linear"] as const;

function trackerLists(
  area: Record<string, unknown>,
  key: string,
  field: "labels" | "flags",
): string[] {
  return TRACKER_BLOCKS.flatMap((block) => {
    const b = area[block];
    if (b === undefined) return [];
    if (!isRecord(b))
      throw new Error(`catalog area ${key}.${block}: not a mapping`);
    return stringList(b[field], `catalog area ${key}.${block}.${field}`);
  });
}

/** An area field whose value has the wrong type. */
class CatalogFieldError extends Error {}

/** Validate a parsed catalog into its areas. Throws with the field at fault. */
export function parseCatalog(raw: unknown): Map<string, CatalogArea> {
  if (!isRecord(raw) || !isRecord(raw.areas))
    throw new Error("the change-area catalog has no `areas` mapping");
  const out = new Map<string, CatalogArea>();
  for (const [key, area] of Object.entries(raw.areas)) {
    if (!isRecord(area)) throw new Error(`catalog area ${key}: not a mapping`);
    const generated = area.generated === undefined ? [] : area.generated;
    if (!Array.isArray(generated))
      throw new Error(`catalog area ${key}.generated: expected a list`);
    const globs = [
      ...globList(area.paths, `catalog area ${key}.paths`),
      ...generated.flatMap((g, i) => {
        if (!isRecord(g))
          throw new Error(`catalog area ${key}.generated[${i}]: not a mapping`);
        return globList(g.source, `catalog area ${key}.generated[${i}].source`);
      }),
    ];
    const trackerLabels = trackerLists(area, key, "labels");
    const labels = [
      ...stringList(area.labels, `catalog area ${key}.labels`),
      ...trackerLabels,
    ];
    const flags = trackerLists(area, key, "flags");
    const serialize = area.serialize === undefined ? false : area.serialize;
    if (typeof serialize !== "boolean")
      throw new CatalogFieldError(
        `catalog area ${key}.serialize: expected true or false`,
      );
    out.set(key, {
      globs,
      labels,
      trackerLabels,
      flags,
      serialize,
      fields: area,
    });
  }
  return out;
}

/**
 * Validate a catalog's `text`; `label` names it in errors. Throws with the
 * label and the reason.
 */
export function loadCatalogText(
  text: string,
  label: string,
): Map<string, CatalogArea> {
  try {
    return parseCatalog(loadYaml(text));
  } catch (err) {
    throw new Error(
      `the change-area catalog ${label} is not valid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Read and validate the consumer's catalog. Throws with the path and the reason. */
export function loadCatalogFile(path: string): Map<string, CatalogArea> {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `the change-area catalog ${path} could not be read (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return loadCatalogText(text, path);
}

/** The keys of the areas whose own globs claim `file`, in catalog order. */
export function areasOf(file: string, catalog: ChangeAreaCatalog): string[] {
  const out: string[] = [];
  for (const [key, area] of catalog)
    if (area.globs.some((g) => matchesGlob(file, g))) out.push(key);
  return out;
}
