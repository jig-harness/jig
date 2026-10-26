import {
  parseChangelogSection,
  resolve as resolveChangelog,
} from "../../../changelog/scripts/config.ts";
import { workingTree } from "../../../changelog/scripts/notes-dir.ts";
import { releasableVersion } from "../../../changelog/scripts/versions.ts";

/**
 * The changelog section resolved against the audited repository as the
 * skill's commands resolve it: the changelog and its format, the version
 * source set or derived from the manifests, and, from version files, the one
 * version they all hold, checked as one the release can move in every file.
 */
export function changelogValidation(
  config: Record<string, unknown>,
  root: string,
): void {
  const section = parseChangelogSection(config.changelog);
  if (section === null) return;
  const read = workingTree(root);
  const resolved = resolveChangelog(root, section, read);
  if (resolved.version.kind === "files")
    releasableVersion(resolved.version, {
      read,
      format: resolved.format,
      tagPrefix: resolved.tagPrefix,
      changelog: read(resolved.changelog) ?? "",
      tags: () => [],
    });
}
