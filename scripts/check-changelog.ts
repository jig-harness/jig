// Scope: CHANGELOG.md, the change notes under changes/ and the plugin
// manifests. Every plugin version that ships has a section, so a release
// always says what changed and what a consumer must do. A branch adds a
// change note rather than editing the changelog or the version, which the
// release step (scripts/release.ts) writes after the merge; a branch that
// changes plugin/ adds a note that asks for a release. The branch is compared
// with its merge base with origin/main, or with $JIG_CHANGE_NOTES_BASE.
// Exit 1 when the current version has no section, the manifests disagree, a
// note is malformed or a branch rule fails; 2 when a file cannot be read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { prose } from "../lib/files.ts";
import { checkNotes } from "../modules/M12-parallel-agent-ergonomics/reference/change-notes/check.ts";
import { versionOf } from "../modules/M12-parallel-agent-ergonomics/reference/change-notes/notes-dir.ts";

export const MANIFESTS = [
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
];
/** Jig's values for M12's change-notes mechanism. */
export const CHANGE_NOTES = {
  notes: "changes",
  changelog: "CHANGELOG.md",
  versionFiles: MANIFESTS,
  tagPrefix: "v",
  // A criterion or configuration field records the version that added it;
  // its branch writes `since: next` and the release names the version.
  stamps: [
    {
      files: [
        "plugin/skills/audit/criteria/*.yaml",
        "plugin/skills/audit/config-schema.yaml",
      ],
      from: "since: next",
      to: "since: {version}",
    },
  ],
};
export const BASE_ENV = "JIG_CHANGE_NOTES_BASE";

/**
 * The `## [x.y.z]` section headings of a Keep a Changelog file, in order. A
 * heading inside a fenced code block is an example, not a section.
 */
export function changelogVersions(content: string): string[] {
  return [...prose(content).matchAll(/^## \[([^\]]+)\]/gm)].map(
    (m) => m[1] ?? "",
  );
}

export function checkChangelog(
  root = ".",
  env: Record<string, string | undefined> = process.env,
): number {
  const versions = MANIFESTS.map((path) =>
    versionOf(readFileSync(join(root, path), "utf8")),
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
      `CHANGELOG.md has no "## [${version}]" section for the current plugin version: the release step (scripts/release.ts) writes it from the change notes`,
    );
    return 1;
  }
  const { findings, skipped } = checkNotes({
    root,
    ...CHANGE_NOTES,
    releasePaths: ["plugin/"],
    base: env[BASE_ENV] || "origin/main",
  });
  for (const f of findings) console.error(f);
  if (findings.length) return 1;
  console.log(
    `changelog: OK — both plugin manifests carry ${version}, CHANGELOG.md has its section, and every change note reads${skipped ? ` (branch checks skipped: ${skipped})` : "; the branch leaves the version and the changelog's sections to the release step"}`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkChangelog(process.argv[2]));
