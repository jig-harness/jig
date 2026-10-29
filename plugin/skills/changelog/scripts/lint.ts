// The whole-changelog check: the repository's changelog read against the
// rules of its own format, and only those. The format is
// `changelog.format`, else the one the file names (formats.ts); Keep a
// Changelog's rules are never run on a Common Changelog file, nor the other
// way round. Each rule cites the section of the format's specification that
// states it (lint-keep-a-changelog.ts, lint-common-changelog.ts), and a
// finding names the file, the line, the rule and what to change.
//
// Release coverage compares the changelog with the version the version files
// hold (where `changelog.version` names files, or they are derived) and with
// the `<tag_prefix><version>` tags in the checkout's history.
//
// Usage: bun lint.ts [--root <dir>] [--json]
// Exit: 0 the file follows its format's rules (or the repository has not
// turned the skill on); 1 findings; 2 a usage error, an invalid configuration,
// an unreadable changelog or one a link leads outside the repository root, or
// coverage that could not be checked (version files that disagree, a shallow
// clone, tags git cannot list) with no finding besides.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fail, runMain } from "../../../shared/cli.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { pluginVersion } from "../../../shared/plugin-version.ts";
import { banner } from "./banner.ts";
import {
  loadChangelogConfig,
  type Resolved,
  resolve as resolveConfig,
} from "./config.ts";
import { ChangelogError } from "./errors.ts";
import { swallow } from "../../../shared/errors.ts";
import type { FormatId } from "./formats.ts";
import { lintCommonChangelog } from "./lint-common-changelog.ts";
import { lintKeepAChangelog } from "./lint-keep-a-changelog.ts";
import {
  type Changelog,
  type Coverage,
  type Finding,
  isSemver,
  readChangelog,
} from "./lint-structure.ts";
import { tryGit } from "./notes-dir.ts";
import { currentVersion, type FileReader } from "./versions.ts";

type Env = Record<string, string | undefined>;

/** The rules of each format; the detected or configured format picks one set. */
export const RULES: Record<
  FormatId,
  (changelog: Changelog, coverage: Coverage) => Finding[]
> = {
  "keep-a-changelog": lintKeepAChangelog,
  "common-changelog": lintCommonChangelog,
};

const NAMES: Record<FormatId, string> = {
  "keep-a-changelog": "Keep a Changelog 1.1.0",
  "common-changelog": "Common Changelog",
};

export interface LintResult {
  plugin: string | null;
  configured: boolean;
  format: FormatId | null;
  file: string | null;
  findings: Finding[];
  /** Why release coverage could not be checked against the tags or the version files; null when it was. */
  unchecked: string | null;
}

/**
 * The versions the tags in the checkout's history name, the prefix removed,
 * or why they cannot be listed in full. A tag on a commit the checkout does
 * not hold (a release made after the branch forked) names a version this
 * changelog cannot have yet; a shallow clone may lack a release's commit
 * altogether, so its tags are not read as the whole history.
 */
function taggedVersions(
  root: string,
  prefix: string,
): { tagged: string[]; unchecked: string | null } {
  const shallow = tryGit(root, ["rev-parse", "--is-shallow-repository"]);
  if (shallow?.trim() !== "false")
    return {
      tagged: [],
      unchecked:
        shallow === null
          ? UNREAD_TAGS
          : "against the tags: the checkout is a shallow clone, whose history may not reach every release: fetch the full history (`git fetch --unshallow`, or `fetch-depth: 0` in CI)",
    };
  const tags = tryGit(root, ["tag", "--list", "--merged", "HEAD"]);
  if (tags === null) return { tagged: [], unchecked: UNREAD_TAGS };
  const tagged = tags.split("\n").flatMap((tag) => {
    const version = tag.startsWith(prefix) ? tag.slice(prefix.length) : "";
    return isSemver(version) ? [version] : [];
  });
  return { tagged, unchecked: null };
}

/** Why coverage could not be checked against the tags git could not list. */
const UNREAD_TAGS =
  "against the tags: git could not list the tags in the checkout's history: run `git tag --merged HEAD` in the repository to see why";

/**
 * What coverage compares with, and why part of it could not be read: the
 * tags in the checkout's history, the version files.
 */
function coverageOf(
  resolved: Resolved,
  read: FileReader,
  changelog: string,
): { coverage: Coverage; unchecked: string | null } {
  const { tagged, unchecked: tags } = taggedVersions(
    resolved.root,
    resolved.tagPrefix,
  );
  const reasons = (files: string | null) => {
    const all = [tags, files].filter((r): r is string => r !== null);
    return all.length ? all.join("; ") : null;
  };
  if (resolved.version.kind !== "files")
    return { coverage: { current: null, tagged }, unchecked: reasons(null) };
  try {
    const current = currentVersion(resolved.version, {
      read,
      format: resolved.format,
      tagPrefix: resolved.tagPrefix,
      changelog,
      tags: () => [],
    });
    return { coverage: { current, tagged }, unchecked: reasons(null) };
  } catch (error) {
    // The reason names the versions the files hold; the report says only
    // where to see them, so nothing read from a file reaches the log.
    swallow(error, "the version files cannot be read as one version");
    return {
      coverage: { current: null, tagged },
      unchecked: reasons(UNCHECKED_FILES),
    };
  }
}

/** Why coverage could not be checked against the version files. */
const UNCHECKED_FILES =
  "against the version files: the version files disagree or hold no readable version: run status.ts to see them";

/**
 * The top level of the repository at `root`, its real path, refused unless
 * `root` is that top level: `changelog.file` and the version files are
 * relative to it. The boundary is the top level git reports, never the
 * argument itself.
 */
function topLevel(root: string): string {
  const top = tryGit(root, ["rev-parse", "--show-toplevel"])?.trim();
  const prefix = tryGit(root, ["rev-parse", "--show-prefix"])?.trim();
  if (!top || prefix !== "")
    throw new ChangelogError(
      `${root} is not the top level of a git repository: run the command from the repository's root`,
    );
  return realpathSync(top);
}

/** The real path of `file` under the top level `base`, refused when a link leads it out. */
function inside(base: string, file: string): string {
  const full = realpathSync(resolve(base, file));
  if (full !== base && full.startsWith(base + sep)) return full;
  throw new ChangelogError(
    `${file} resolves outside the repository root: point the configuration at a file inside the repository`,
  );
}

/**
 * The changelog's real path inside the repository at `root`, refused when it
 * is not inside that repository's work tree. `changelog.file` holds no `..`
 * segment, but a link in the tree could still lead out of it.
 */
export function changelogPath(root: string, file: string): string {
  return inside(topLevel(root), file);
}

/**
 * A reader of the files of the repository at `root` that checks each path
 * before reading it: a path a link leads outside the repository, or one that
 * is not a regular file (a device, a pipe), is refused, so the check never
 * reads what it would then refuse. A path that does not exist reads as null.
 */
export function repositoryReader(root: string): FileReader {
  const base = topLevel(root);
  return (file) => {
    if (!existsSync(resolve(base, file))) return null;
    const full = inside(base, file);
    if (!statSync(full).isFile())
      throw new ChangelogError(
        `${file} is not a regular file: point the configuration at a file inside the repository`,
      );
    return readFileSync(full, "utf8");
  };
}

/** The changelog of the repository `resolved` describes, against its format's rules. */
export function lintResolved(
  resolved: Resolved,
  read: FileReader = repositoryReader(resolved.root),
): LintResult {
  const text = read(resolved.changelog);
  if (text === null)
    throw new ChangelogError(
      `changelog.file: ${resolved.changelog} does not exist: create it, or point the field at the changelog`,
    );
  const { coverage, unchecked } = coverageOf(resolved, read, text);
  const findings = RULES[resolved.format.id](
    readChangelog(resolved.changelog, text),
    coverage,
  );
  return {
    plugin: pluginVersion(),
    configured: true,
    format: resolved.format.id,
    file: resolved.changelog,
    findings,
    unchecked,
  };
}

/** Workflow-command escaping, for a GitHub Actions annotation. */
const escapeCommand = (text: string, property = false): string => {
  const data = text
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  return property ? data.replaceAll(":", "%3A").replaceAll(",", "%2C") : data;
};

function report(result: LintResult, env: Env): void {
  console.log(banner("lint"));
  if (!result.configured) {
    console.log("not configured (no changelog.file in .config/jig.yaml)");
    return;
  }
  const name = result.format ? NAMES[result.format] : "its format";
  for (const f of result.findings)
    console.error(
      `${f.file}:${f.line}: [${f.rule}] ${f.problem}\n  fix: ${f.remedy}`,
    );
  if (env.GITHUB_ACTIONS === "true")
    for (const f of result.findings)
      console.log(
        `::error file=${escapeCommand(f.file, true)},line=${f.line},title=${escapeCommand(f.rule, true)}::${escapeCommand(`${f.problem} Fix: ${f.remedy}`)}`,
      );
  if (result.unchecked)
    console.error(`release coverage not checked ${result.unchecked}`);
  console.log(
    result.findings.length
      ? `changelog lint: ${result.findings.length} finding(s) in ${result.file} against ${name}'s rules`
      : `changelog lint: OK — ${result.file} follows ${name}'s rules${result.unchecked ? ", release coverage aside" : ""}`,
  );
}

/** Lint the changelog of the repository at `root` and report; the exit status. */
export function runLint(
  root: string,
  json: boolean,
  env: Env = process.env,
): number {
  // The configuration first, then every file it names through the checked
  // reader: resolving the format and the version files reads them too.
  const config = loadChangelogConfig(root, env);
  let result: LintResult;
  if (config === null)
    result = {
      plugin: pluginVersion(),
      configured: false,
      format: null,
      file: null,
      findings: [],
      unchecked: null,
    };
  else {
    const read = repositoryReader(root);
    result = lintResolved(resolveConfig(root, config, read), read);
  }
  if (json) console.log(JSON.stringify(result));
  else report(result, env);
  if (result.findings.length) return 1;
  return result.unchecked ? 2 : 0;
}

/** The command line's options: the repository's root and whether to print JSON. */
function options(): { root: string; json: boolean } {
  const { values } = parseArgs({
    options: {
      json: { type: "boolean", default: false },
      root: { type: "string" },
    },
  });
  return {
    root: values.root === undefined ? consumerRoot() : resolve(values.root),
    json: values.json,
  };
}

if (import.meta.main)
  runMain("lint", async () => {
    try {
      const { root, json } = options();
      return runLint(root, json);
    } catch (error) {
      fail(2, error instanceof Error ? error.message : String(error));
    }
  });
