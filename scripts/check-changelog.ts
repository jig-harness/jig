// Scope: CHANGELOG.md, the change notes under changes/ and the plugin
// manifests, as the `changelog:` section of .config/jig.yaml names them. Every
// plugin version that ships has a section, so a release always says what
// changed and what a consumer must do. A branch adds a change note rather than
// editing the changelog or the version, which the release step
// (scripts/release.ts) writes after the merge; a branch that changes plugin/
// adds a note that asks for a release. The branch is held to the section its
// base holds and is compared with its merge base with $JIG_CHANGE_NOTES_BASE,
// else the base of the pull request that started the CI job, else main.
// Exit 1 when the current version has no section, the manifests disagree, a
// note is malformed or a branch rule fails; 2 when a file cannot be read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { prose } from "../lib/files.ts";
import { checkBase } from "../plugin/skills/changelog/scripts/branches.ts";
import { checkBranch } from "../plugin/skills/changelog/scripts/check.ts";
import { loadResolved } from "../plugin/skills/changelog/scripts/config.ts";
import {
  currentVersionOf,
  readNotes,
} from "../plugin/skills/changelog/scripts/notes-dir.ts";

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
  const resolved = loadResolved(root, env);
  if (resolved === null) {
    console.error(
      "the changelog skill is not configured: .config/jig.yaml has no changelog.file",
    );
    return 1;
  }
  let version: string;
  try {
    version = currentVersionOf(resolved);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const headings = changelogVersions(
    readFileSync(join(root, resolved.changelog), "utf8"),
  );
  if (!headings.includes(version)) {
    console.error(
      `${resolved.changelog} has no "## [${version}]" section for the current plugin version: the release step (scripts/release.ts) writes it from the change notes`,
    );
    return 1;
  }
  const explicit = env[BASE_ENV] || null;
  const { findings, notices, skipped, configured } = checkBranch(
    root,
    checkBase(root, explicit, env),
    env,
    explicit !== null,
  );
  // Until the base holds the section, the notes are still held to the
  // section the branch proposes.
  if (!configured) findings.push(...readNotes(resolved).errors);
  for (const n of notices) console.log(`note: ${n}`);
  for (const f of findings) console.error(f);
  if (findings.length) return 1;
  console.log(
    `changelog: OK — both plugin manifests carry ${version}, ${resolved.changelog} has its section, and every change note reads${skipped ? ` (branch checks skipped: ${skipped})` : configured ? "; the branch leaves the version and the changelog's sections to the release step" : " (the base does not hold the changelog section yet, so the branch rules start with the merge that adds it)"}`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkChangelog(process.argv[2]));
