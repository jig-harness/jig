/**
 * Where the repository's label taxonomy is: `issue_tracker.taxonomy` in its
 * Jig configuration, a path relative to the repository root, else
 * `label-taxonomy.yaml` at the root.
 */
import { isAbsolute, join } from "node:path";
import {
  consumerRoot,
  readConfig,
  withSource,
} from "../../../../shared/consumer.ts";
import { isRecord } from "../../../../shared/guards.ts";

export const DEFAULT_TAXONOMY = "label-taxonomy.yaml";

/** The configured taxonomy path as written, or the default. */
export function taxonomySetting(values: Record<string, unknown>): string {
  const section = values.issue_tracker;
  const value = isRecord(section) ? section.taxonomy : undefined;
  if (value === undefined || value === null) return DEFAULT_TAXONOMY;
  if (typeof value !== "string" || value.trim() === "")
    throw withSource(
      values,
      "issue_tracker",
      new Error(
        "issue_tracker.taxonomy must be a path to the label taxonomy, relative to the repository root",
      ),
    );
  return value;
}

/** The absolute path of the consumer's label taxonomy. */
export function taxonomyPath(root = consumerRoot()): string {
  return taxonomyAt(root, taxonomySetting(readConfig()));
}

/**
 * The file a taxonomy `setting` names from `root`: absolute as written,
 * relative joined to the root. The audit reads the taxonomy through this
 * too, so it checks the file this skill uses.
 */
export function taxonomyAt(root: string, setting: string): string {
  return isAbsolute(setting) ? setting : join(root, setting);
}
