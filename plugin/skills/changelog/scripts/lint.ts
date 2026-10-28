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
// version files that disagree (coverage could not
// be checked) with no finding besides.
import { readFileSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { fail, runMain } from "../../../shared/cli.ts";
import { consumerRoot } from "../../../shared/consumer.ts";
import { pluginVersion } from "../../../shared/plugin-version.ts";
import { banner } from "./banner.ts";
import { loadResolved, type Resolved } from "./config.ts";
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
import { currentVersionOf, tryGit } from "./notes-dir.ts";

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
  /** Why release coverage could not be checked against the version files; null when it was. */
  unchecked: string | null;
}

/**
 * The versions the tags in the checkout's history name, the prefix removed. A
 * tag on a commit the checkout does not hold (a release made after the branch
 * forked) names a version this changelog cannot have yet.
 */
function taggedVersions(root: string, prefix: string): string[] {
  const tags = tryGit(root, ["tag", "--list", "--merged", "HEAD"]) ?? "";
  return tags.split("\n").flatMap((tag) => {
    const version = tag.startsWith(prefix) ? tag.slice(prefix.length) : "";
    return isSemver(version) ? [version] : [];
  });
}

/** What coverage compares with, and why the version files could not be read. */
function coverageOf(resolved: Resolved): {
  coverage: Coverage;
  unchecked: string | null;
} {
  const tagged = taggedVersions(resolved.root, resolved.tagPrefix);
  if (resolved.version.kind !== "files")
    return { coverage: { current: null, tagged }, unchecked: null };
  try {
    return {
      coverage: { current: currentVersionOf(resolved), tagged },
      unchecked: null,
    };
  } catch (error) {
    // The reason names the versions the files hold; the report says only
    // where to see them, so nothing read from a file reaches the log.
    swallow(error, "the version files cannot be read as one version");
    return { coverage: { current: null, tagged }, unchecked: UNCHECKED };
  }
}

/** Why coverage could not be checked against the version files. */
const UNCHECKED =
  "the version files disagree or hold no readable version: run status.ts to see them";

/**
 * The changelog's real path, refused when it is not inside the repository
 * root: `changelog.file` is relative with no `..` segment, but a link in the
 * tree could still lead out of it.
 */
export function changelogPath(root: string, file: string): string {
  const base = realpathSync(resolve(root));
  const full = realpathSync(resolve(base, file));
  if (full !== base && full.startsWith(base + sep)) return full;
  throw new ChangelogError(
    `changelog.file: ${file} resolves outside the repository root: point it at a file inside the repository`,
  );
}

/** The changelog of the repository `resolved` describes, against its format's rules. */
export function lintResolved(resolved: Resolved): LintResult {
  const text = readFileSync(
    changelogPath(resolved.root, resolved.changelog),
    "utf8",
  );
  const { coverage, unchecked } = coverageOf(resolved);
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
    console.error(
      `release coverage not checked against the version files: ${result.unchecked}`,
    );
  console.log(
    result.findings.length
      ? `changelog lint: ${result.findings.length} finding(s) in ${result.file} against ${name}'s rules`
      : `changelog lint: OK — ${result.file} follows ${name}'s rules${result.unchecked ? ", release coverage against the version files aside" : ""}`,
  );
}

/** Lint the changelog of the repository at `root` and report; the exit status. */
export function runLint(
  root: string,
  json: boolean,
  env: Env = process.env,
): number {
  const resolved = loadResolved(root, env);
  const result: LintResult =
    resolved === null
      ? {
          plugin: pluginVersion(),
          configured: false,
          format: null,
          file: null,
          findings: [],
          unchecked: null,
        }
      : lintResolved(resolved);
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
