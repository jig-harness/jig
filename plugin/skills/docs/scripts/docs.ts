#!/usr/bin/env bun
/**
 * Check a repository's docs tree in one pass: run the frontmatter check, the
 * index freshness check, the last_updated check over the branch, the scar lint
 * and the deferral check, each through its own command line; flag drafts left
 * stale; and list the documents the project's type calls for that the tree
 * lacks. Run from the repository root (or set JIG_CONSUMER_ROOT).
 *
 * Usage: docs.ts [--json] [--base <ref>] [--type service|library|application]
 *
 *   --json   the report as JSON (schema docs-report/v1) instead of text
 *   --base   the branch the last_updated check compares with (default:
 *            repository.base_branch, else the remote's default branch)
 *   --type   the project type, when the one detected from the tree is wrong
 *
 * Exit codes: 0 no error found; 1 a check found an error; 2 a check could not
 * run, or the command line or configuration is unusable, whatever the other
 * checks found. Warnings (stale drafts, orphaned documents) and missing
 * documents never fail the run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adrConfig } from "../../adr/scripts/locate.ts";
import { consumerRoot, readConfig } from "../../../shared/consumer.ts";
import { git } from "../../../shared/proc.ts";
import { DEFAULT_CONFIG as DEFERRAL_CONFIG } from "./deferral-references/check-deferrals.ts";
import { cli, isGeneratedIndex } from "./lib/docs.ts";
import { staleDrafts, today } from "./lib/drafts.ts";
import {
  type CheckResult,
  type Gate,
  readDeferralOutput,
  readFrontmatterOutput,
  readIndexOutput,
  readScarOutput,
  readStaleOutput,
  runGate,
  summarize,
} from "./lib/gates.ts";
import {
  type Detected,
  decisionDirectory,
  detectProjectType,
  expectedDocuments,
  PROJECT_TYPES,
  type ProjectType,
} from "./lib/plan.ts";
import { exitCode, type Report, renderJson, renderText } from "./lib/report.ts";
import { type DocsSettings, loadDocsSettings } from "./lib/settings.ts";

const USAGE =
  "usage: docs.ts [--json] [--base <ref>] [--type service|library|application]";

const GIT_TIMEOUT_SEC = 60;

/** A command line the script cannot act on (exit 2). */
export class UsageError extends Error {}

/** A configured value the pass cannot act on (exit 2). */
export class ConfigError extends Error {}

interface Options {
  json: boolean;
  base?: string;
  type?: ProjectType;
}

export function parseArgs(argv: string[]): Options {
  const options: Options = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--json") options.json = true;
    else if (arg === "--base" && value) {
      options.base = value;
      i++;
    } else if (arg === "--type" && value) {
      if (!(PROJECT_TYPES as readonly string[]).includes(value))
        throw new UsageError(
          `--type must be one of ${PROJECT_TYPES.join(", ")}`,
        );
      options.type = value as ProjectType;
      i++;
    } else throw new UsageError(`unknown argument ${arg ?? ""}\n${USAGE}`);
  }
  return options;
}

const skipped = (name: string, detail: string): CheckResult => ({
  name,
  status: "skipped",
  detail,
  findings: [],
});

const NO_TREE = "no docs tree (set docs.root)";

const failed = (name: string, detail: string): CheckResult => ({
  name,
  status: "failed",
  detail,
  findings: [],
});

/** Why a git call that did not exit 0 failed. */
const gitFailure = (result: { stderr: string; code: number }) =>
  result.stderr.trim() || `exit ${result.code}`;

async function resolves(repo: string, ref: string): Promise<boolean> {
  const result = await git(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    { cwd: repo, timeoutSec: GIT_TIMEOUT_SEC },
  );
  return result.code === 0;
}

/**
 * The base the last_updated check compares with, or null when none resolves.
 * A configured `repository.base_branch` names the integration branch, so one
 * that does not resolve is refused rather than replaced by another branch.
 */
async function baseRef(repo: string, given?: string): Promise<string | null> {
  if (given) return given;
  const configured = (readConfig().repository as Record<string, unknown>)
    ?.base_branch;
  if (typeof configured === "string" && configured) {
    for (const ref of [`origin/${configured}`, configured])
      if (await resolves(repo, ref)) return ref;
    throw new ConfigError(
      `repository.base_branch is ${configured}, but neither origin/${configured} nor ${configured} resolves to a commit; fetch it, or pass --base <ref>`,
    );
  }
  const remoteHead = await git(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { cwd: repo, timeoutSec: GIT_TIMEOUT_SEC },
  );
  const candidates = [
    ...(remoteHead.code === 0 ? [remoteHead.stdout.trim()] : []),
    "origin/main",
    "main",
    "origin/master",
    "master",
  ];
  for (const ref of candidates) if (await resolves(repo, ref)) return ref;
  return null;
}

/** Paths git listed, or why it could not list them. */
type Listing = { paths: string[] } | { failed: string };

/**
 * The repository's tracked files. A failed listing is reported, not read as
 * an empty tree: no files would detect no project type and plan nothing.
 */
async function trackedFiles(repo: string): Promise<Listing> {
  const result = await git(["ls-files", "-z"], {
    cwd: repo,
    timeoutSec: GIT_TIMEOUT_SEC,
  });
  return result.code === 0
    ? { paths: result.stdout.split("\0").filter(Boolean) }
    : { failed: `git ls-files failed: ${gitFailure(result)}` };
}

/**
 * The documents the branch adds under the docs tree, which the frontmatter
 * check holds to the schema's `required_new` fields. None without a base.
 * Rename detection is on, whatever the user's `diff.renames`: a page moved
 * within the tree is not a new page.
 */
async function addedDocs(
  repo: string,
  root: string,
  base: string | null,
): Promise<Listing> {
  if (base === null) return { paths: [] };
  const result = await git(
    [
      "diff",
      "--name-only",
      "-z",
      "-M",
      "--diff-filter=A",
      `${base}...HEAD`,
      "--",
      root,
    ],
    { cwd: repo, timeoutSec: GIT_TIMEOUT_SEC },
  );
  if (result.code !== 0)
    return {
      failed: `the documents added since ${base} could not be listed: ${gitFailure(result)}`,
    };
  return {
    paths: result.stdout
      .split("\0")
      .filter((path) => path.endsWith(".md") && existsSync(join(repo, path))),
  };
}

/** The frontmatter gate, or why it does not apply or cannot run. */
function frontmatterGate(
  settings: DocsSettings,
  added: Listing,
): Gate | CheckResult {
  const { root, schema } = settings;
  if (root === null) return skipped("frontmatter", NO_TREE);
  if (schema === null)
    return skipped(
      "frontmatter",
      `no frontmatter schema under ${root}/ (set docs.schema)`,
    );
  if ("failed" in added) return failed("frontmatter", added.failed);
  return {
    name: "frontmatter",
    script: "frontmatter-check/frontmatter-check.ts",
    args: [],
    env: { DOCS_DIR: root, SCHEMA: schema, NEW_DOCS: added.paths.join("\n") },
    read: readFrontmatterOutput,
  };
}

/** The gates, or why each does not apply to this tree. */
function gates(
  repo: string,
  settings: DocsSettings,
  base: string | null,
  added: Listing,
): (Gate | CheckResult)[] {
  const { root } = settings;
  const noTree = NO_TREE;
  const index = root === null ? "" : join(repo, root, "INDEX.md");
  const generated =
    index !== "" &&
    existsSync(index) &&
    isGeneratedIndex(readFileSync(index, "utf8"));
  return [
    frontmatterGate(settings, added),
    generated && root !== null
      ? {
          name: "index",
          script: "index/generate-index.ts",
          args: ["--check"],
          env: { DOCS_DIR: root },
          read: readIndexOutput,
        }
      : skipped(
          "index",
          root === null ? noTree : `no generated ${root}/INDEX.md`,
        ),
    root === null
      ? skipped("last_updated", noTree)
      : base === null
        ? skipped("last_updated", "no base branch resolves (pass --base <ref>)")
        : {
            name: "last_updated",
            script: "stale-last-updated/stale-last-updated.ts",
            args: [],
            env: { DIFF_RANGE: `${base}...HEAD` },
            read: readStaleOutput,
            under: root,
          },
    root === null
      ? skipped("scars", noTree)
      : {
          name: "scars",
          script: "scar-lint/check-descarring-scars.ts",
          args: [],
          env: { DOCS_DIR: root },
          read: readScarOutput,
        },
    existsSync(join(repo, DEFERRAL_CONFIG))
      ? {
          name: "deferrals",
          script: "deferral-references/check-deferrals.ts",
          args: ["--all"],
          env: {},
          read: readDeferralOutput,
        }
      : skipped("deferrals", `not configured (no ${DEFERRAL_CONFIG})`),
  ];
}

/** The project type, and the failed check when the files could not be listed. */
async function projectType(
  repo: string,
  given?: ProjectType,
): Promise<[Detected, CheckResult | null]> {
  if (given) return [{ type: given, evidence: "--type" }, null];
  const tracked = await trackedFiles(repo);
  if ("failed" in tracked)
    return [
      { type: "unknown", evidence: tracked.failed },
      failed("project type", tracked.failed),
    ];
  return [detectProjectType(repo, tracked.paths), null];
}

export async function runDocs(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const repo = consumerRoot();
  const settings = loadDocsSettings(repo);
  const decisions = decisionDirectory(repo, adrConfig().directory);
  const on = today(process.env);
  const base = await baseRef(repo, options.base);
  const added: Listing =
    settings.root === null
      ? { paths: [] }
      : await addedDocs(repo, settings.root, base);
  const checks: CheckResult[] = [];
  for (const gate of gates(repo, settings, base, added))
    checks.push("script" in gate ? await runGate(gate, repo) : gate);
  checks.push(
    settings.root === null
      ? skipped("stale drafts", NO_TREE)
      : summarize(
          "stale drafts",
          staleDrafts(repo, settings.root, settings.staleAfterDays, on),
          `no draft older than ${settings.staleAfterDays} days`,
        ),
  );
  const [project, census] = await projectType(repo, options.type);
  if (census) checks.push(census);
  const report: Report = {
    root: settings.root,
    schema: settings.schema,
    base,
    staleAfterDays: settings.staleAfterDays,
    project,
    checks,
    expected: expectedDocuments(
      repo,
      settings.root,
      settings.schema,
      project.type,
      decisions,
    ),
  };
  process.stdout.write(options.json ? renderJson(report) : renderText(report));
  return exitCode(report);
}

if (import.meta.main) cli(() => runDocs(process.argv.slice(2)));
