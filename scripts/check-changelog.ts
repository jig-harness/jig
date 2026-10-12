// Scope: CHANGELOG.md against the plugin manifests. Every plugin version that
// ships has a section, so a release always says what changed and what a
// consumer must do. Exit 1 when the current version has no section or the
// manifests disagree; 2 when a file cannot be read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { prose } from "../lib/files.ts";

const MANIFESTS = [
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
];

/**
 * The `## [x.y.z]` section headings of a Keep a Changelog file, in order. A
 * heading inside a fenced code block is an example, not a section.
 */
export function changelogVersions(content: string): string[] {
  return [...prose(content).matchAll(/^## \[([^\]]+)\]/gm)].map(
    (m) => m[1] ?? "",
  );
}

export function checkChangelog(root = "."): number {
  const versions = MANIFESTS.map(
    (path) =>
      (
        JSON.parse(readFileSync(join(root, path), "utf8")) as {
          version?: string;
        }
      ).version ?? "",
  );
  const [version] = versions;
  if (!version || versions.some((v) => v !== version)) {
    console.error(
      `plugin manifests disagree on version: ${MANIFESTS.map((p, i) => `${p}=${versions[i] || "(none)"}`).join(", ")}`,
    );
    return 1;
  }
  const headings = changelogVersions(
    readFileSync(join(root, "CHANGELOG.md"), "utf8"),
  );
  if (!headings.includes(version)) {
    console.error(
      `CHANGELOG.md has no "## [${version}]" section for the current plugin version: add one describing this release`,
    );
    return 1;
  }
  return 0;
}
if (import.meta.main) cli(() => checkChangelog(...process.argv.slice(2)));
