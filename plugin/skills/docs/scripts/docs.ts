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
 * run, or the command line or configuration is unusable. Warnings (stale
 * drafts, orphaned documents) and missing documents never fail the run.
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

async function resolves(repo: string, ref: string): Promise<boolean> {
  const result = await git(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
    { cwd: repo, timeoutSec: GIT_TIMEOUT_SEC },
  );
  return result.code === 0;
}

/** The base the last_updated check compares with, or null when none resolves. */
async function baseRef(repo: string, given?: string): Promise<string | null> {
  if (given) return given;
  const configured = (readConfig().repository as Record<string, unknown>)
    ?.base_branch;
  const remoteHead = await git(
    ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
    { cwd: repo, timeoutSec: GIT_TIMEOUT_SEC },
  );
  const candidates = [
    ...(typeof configured === "string" && configured
      ? [`origin/${configured}`, configured]
      : []),
    ...(remoteHead.code === 0 ? [remoteHead.stdout.trim()] : []),
    "origin/main",
    "main",
    "origin/master",
    "master",
  ];
  for (const ref of candidates) if (await resolves(repo, ref)) return ref;
  return null;
}

/** The repository's tracked files; empty when git cannot list them. */
async function trackedFiles(repo: string): Promise<string[]> {
  const result = await git(["ls-files", "-z"], {
    cwd: repo,
    timeoutSec: GIT_TIMEOUT_SEC,
  });
  return result.code === 0 ? result.stdout.split("\0").filter(Boolean) : [];
}

function decisionDir(repo: string): string | null {
  try {
    return decisionDirectory(repo, adrConfig().directory);
  } catch {
    return decisionDirectory(repo);
  }
}

/** The five gates, or why each does not apply to this tree. */
function gates(
  repo: string,
  settings: DocsSettings,
  base: string | null,
): (Gate | CheckResult)[] {
  const { root, schema } = settings;
  const noTree = "no docs tree (set docs.root)";
  const index = root === null ? "" : join(repo, root, "INDEX.md");
  const generated =
    index !== "" &&
    existsSync(index) &&
    isGeneratedIndex(readFileSync(index, "utf8"));
  return [
    root === null
      ? skipped("frontmatter", noTree)
      : schema === null
        ? skipped(
            "frontmatter",
            `no frontmatter schema under ${root}/ (set docs.schema)`,
          )
        : {
            name: "frontmatter",
            script: "frontmatter-check/frontmatter-check.ts",
            args: [],
            env: { DOCS_DIR: root, SCHEMA: schema },
            read: readFrontmatterOutput,
          },
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

export async function runDocs(argv: string[]): Promise<number> {
  const options = parseArgs(argv);
  const repo = consumerRoot();
  const settings = loadDocsSettings(repo);
  const on = today(process.env);
  const base = await baseRef(repo, options.base);
  const checks: CheckResult[] = [];
  for (const gate of gates(repo, settings, base))
    checks.push("script" in gate ? await runGate(gate, repo) : gate);
  checks.push(
    settings.root === null
      ? skipped("stale drafts", "no docs tree (set docs.root)")
      : summarize(
          "stale drafts",
          staleDrafts(repo, settings.root, settings.staleAfterDays, on),
          `no draft older than ${settings.staleAfterDays} days`,
        ),
  );
  const project: Detected = options.type
    ? { type: options.type, evidence: "--type" }
    : detectProjectType(repo, await trackedFiles(repo));
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
      decisionDir(repo),
    ),
  };
  process.stdout.write(options.json ? renderJson(report) : renderText(report));
  return exitCode(report);
}

if (import.meta.main) cli(() => runDocs(process.argv.slice(2)));
