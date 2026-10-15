// The branch side of change notes: every note can be read by the release
// step, and the branch leaves to that step what only it may write: the
// version and the changelog's Unreleased and release sections. A branch that
// changes a released path carries a note that asks for a release. Edits to an
// earlier release's text (a typo, a link) stay allowed: they are rare and
// touch lines no other branch does.
//
// Usage: bun check.ts --notes <dir> --changelog <file>
//          --version-file <json> […] [--release-path <prefix> …]
//          [--root <dir>] [--base <ref>]
// Without --base, or on the base itself, only the notes themselves are
// checked, and the output says so. A --base that git cannot compare against
// is a finding: the branch rules must not pass because they did not run.
// Exit: 0 clean, 1 findings, 2 a usage error or an unreadable file.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cli } from "../../../../lib/cli.ts";
import {
  parseNote,
  releasedVersions,
  unreleasedSection,
} from "./change-notes.ts";
import {
  isNoteFile,
  type NotesConfig,
  readNotes,
  tryGit,
  versionOf,
} from "./notes-dir.ts";

export interface CheckOptions extends NotesConfig {
  /** Path prefixes whose change ships only in a release, such as `plugin/`. */
  releasePaths: string[];
  /** The branch the change merges into; null checks only the notes. */
  base: string | null;
}

export interface CheckResult {
  findings: string[];
  /** Why the branch checks did not run; null when they did. */
  skipped: string | null;
}

/** The branch as the checks read it: what it changed, and each file before and now. */
interface Branch {
  changed: string[];
  atBase: (path: string) => string | null;
  now: (path: string) => string | null;
}

/** NUL-separated git output as a list; git quotes unusual names otherwise. */
const paths = (out: string) => out.split("\0").filter(Boolean);

/**
 * The branch against its merge base with `base`; `skipped` on the base
 * itself, `failed` when git cannot make the comparison.
 */
function readBranch(
  root: string,
  base: string,
): Branch | { skipped: string } | { failed: string } {
  const head = tryGit(root, ["rev-parse", "HEAD"])?.trim();
  const mergeBase = tryGit(root, ["merge-base", "HEAD", base])?.trim();
  if (!head || !mergeBase)
    return {
      failed: `the branch cannot be compared with ${base} (no such revision, or no merge base): fetch it, or give a base git can find`,
    };
  const status = tryGit(root, ["status", "--porcelain", "-z"]);
  const diff = tryGit(root, ["diff", "--name-only", "-z", mergeBase]);
  const untracked = tryGit(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (status === null || diff === null || untracked === null)
    return {
      failed: `git could not list what the branch changes against ${base}`,
    };
  if (head === mergeBase && !paths(status).length)
    return { skipped: `HEAD is ${base}` };
  return {
    changed: [...paths(diff), ...paths(untracked)],
    atBase: (path) => tryGit(root, ["show", `${mergeBase}:${path}`]),
    now: (path) => {
      const full = join(root, path);
      return existsSync(full) ? readFileSync(full, "utf8") : null;
    },
  };
}

function versionFindings(options: CheckOptions, branch: Branch): string[] {
  return options.versionFiles.flatMap((file) => {
    const before = version(branch.atBase(file));
    const after = version(branch.now(file));
    return before !== null && before !== after
      ? [
          `${file}: the branch moves the version from ${before} to ${String(after)}; the release step sets it after the merge, so leave it and give the change note a \`release:\``,
        ]
      : [];
  });
}

function changelogFindings(options: CheckOptions, branch: Branch): string[] {
  const before = branch.atBase(options.changelog);
  const after = branch.now(options.changelog);
  if (before === null) return [];
  if (after === null)
    return [
      `${options.changelog}: the branch deletes the changelog, whose sections the release step writes`,
    ];
  const findings: string[] = [];
  if (unreleasedSection(before) !== unreleasedSection(after))
    findings.push(
      `${options.changelog}: the branch edits Unreleased, which the release step writes; put the change in a note under ${options.notes}/ instead`,
    );
  const versions = (text: string) => releasedVersions(text).join(" ");
  if (versions(before) !== versions(after))
    findings.push(
      `${options.changelog}: the branch adds or removes a release section, which the release step writes; put the change in a note under ${options.notes}/ with \`release:\` instead`,
    );
  return findings;
}

function releaseFindings(options: CheckOptions, branch: Branch): string[] {
  const released = branch.changed.filter((f) =>
    options.releasePaths.some((p) => f.startsWith(p)),
  );
  if (!released.length) return [];
  const asksRelease = branch.changed
    .filter((f) => isNoteFile(options.notes, f))
    .some((f) => {
      const text = branch.now(f);
      return text !== null && parseNote(f, text).note?.release != null;
    });
  if (asksRelease) return [];
  const more = released.length > 3 ? ` and ${released.length - 3} more` : "";
  return [
    `${released.slice(0, 3).join(", ")}${more} changed, which ships only in a release, but no change note under ${options.notes}/ asks for one: add a note with \`release: patch|minor|major\``,
  ];
}

export function checkNotes(options: CheckOptions): CheckResult {
  const findings = [...readNotes(options).errors];
  if (!options.base) return { findings, skipped: "no base branch given" };
  const branch = readBranch(options.root, options.base);
  if ("failed" in branch)
    return { findings: [...findings, branch.failed], skipped: null };
  if ("skipped" in branch) return { findings, skipped: branch.skipped };
  findings.push(
    ...versionFindings(options, branch),
    ...changelogFindings(options, branch),
    ...releaseFindings(options, branch),
  );
  return { findings, skipped: null };
}

function version(json: string | null): string | null {
  return json === null ? null : versionOf(json);
}

/** Run the check and report it; the exit status for the command line. */
export function runCheck(options: CheckOptions): number {
  const { findings, skipped } = checkNotes(options);
  for (const f of findings) console.error(f);
  if (findings.length) return 1;
  console.log(
    skipped
      ? `change notes: OK — every note reads; branch checks skipped (${skipped})`
      : `change notes: OK — every note reads, and the branch leaves the version and the changelog's sections to the release step`,
  );
  return 0;
}

if (import.meta.main)
  cli(() => {
    const { values } = parseArgs({
      options: {
        root: { type: "string", default: "." },
        notes: { type: "string" },
        changelog: { type: "string" },
        "version-file": { type: "string", multiple: true },
        "release-path": { type: "string", multiple: true },
        base: { type: "string" },
      },
    });
    if (!values.notes || !values.changelog || !values["version-file"]?.length)
      throw new Error(
        "usage: check.ts --notes <dir> --changelog <file> --version-file <json> […] [--release-path <prefix> …] [--base <ref>]",
      );
    return runCheck({
      root: resolve(values.root),
      notes: values.notes,
      changelog: values.changelog,
      versionFiles: values["version-file"],
      releasePaths: values["release-path"] ?? [],
      base: values.base ?? null,
    });
  });
