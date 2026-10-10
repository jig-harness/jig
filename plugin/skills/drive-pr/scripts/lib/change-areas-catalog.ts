/**
 * Read the consumer's change-area catalog (`drive.change_areas_catalog`): a
 * YAML file whose `areas` map names each area of the repository by key. The
 * drive loop only needs the keys and each area's declared fields as data, so
 * the schema checked here is the minimal one: a top-level object with an
 * `areas` object whose values are objects. Everything else in the file
 * belongs to the consumer's own tooling.
 */
import { readFileSync } from "node:fs";
import { load } from "../../../resolve-review-comments/scripts/lib/yaml.ts";

export interface ChangeAreaCatalog {
  areas: Record<string, Record<string, unknown>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and check a catalog file; throws with the path on any violation. */
export function readChangeAreaCatalog(path: string): ChangeAreaCatalog {
  let doc: unknown;
  try {
    doc = load(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(
      `change-area catalog could not be read: ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isObject(doc) || !isObject(doc.areas))
    throw new Error(
      `change-area catalog has no 'areas' map: ${path} (expected areas: {<key>: {...}})`,
    );
  for (const [key, area] of Object.entries(doc.areas))
    if (!isObject(area))
      throw new Error(
        `change-area catalog area '${key}' is not a map: ${path}`,
      );
  return { areas: doc.areas as Record<string, Record<string, unknown>> };
}
