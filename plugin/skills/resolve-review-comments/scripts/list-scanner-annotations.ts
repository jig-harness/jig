#!/usr/bin/env bun
/**
 * List the findings a static-analysis app reported as check-run annotations
 * on a PR's head commit, as NDJSON — one finding per line.
 *
 * SonarQube Cloud decorates a pull request this way: its findings are
 * annotations on the "SonarCloud Code Analysis" check, with no review thread
 * and no code scanning alert, so `list-unresolved-threads.ts` never shows
 * them. This lists them for the loop to triage; see `lib/scanner-annotations.ts`.
 *
 * Each line: { app, checkRunId, path, line, startLine, level, title, url }
 *   - level → `warning` or `failure`; `notice` annotations are left out.
 *   - url → the tool's page for the finding (SonarQube Cloud's issue page).
 *
 * Usage: bun list-scanner-annotations.ts [PR_NUMBER]
 *   PR_NUMBER defaults to the PR for the current branch.
 *
 * Apps read: `review.scanner_apps` (GitHub App slugs), else `sonarqubecloud`.
 *
 * Exit codes: 0 every scanner check on the head has completed and the lines
 * printed are all its findings (none printed: the head is clean); 2 bad
 * usage or configuration; 3 a scanner check has not completed on the head, so
 * the lines printed may be partial: wait and list again; anything else is a
 * failed `gh` call.
 */

import { runMain } from "../../../shared/cli.ts";
import { reviewConfig } from "../../../shared/consumer.ts";
import { ghOrExit, repoViewOrExit } from "./lib/gh.ts";
import {
  DEFAULT_SCANNER_APPS,
  findingsOf,
  type ScannerRun,
  scannerRuns,
} from "./lib/scanner-annotations.ts";

const LABEL = "list-scanner-annotations";

/** Every element of a `gh api --paginate --slurp` result, pages flattened. */
function flatten(raw: string, key?: string): unknown[] {
  const pages: unknown = JSON.parse(raw);
  return (Array.isArray(pages) ? pages : [pages]).flatMap((p) => {
    const part = key === undefined ? p : (p as Record<string, unknown>)?.[key];
    return Array.isArray(part) ? part : [];
  });
}

/** The PR argument, else the current branch's; `null` after a usage error. */
async function targetPr(args: string[]): Promise<string | null> {
  const bad = args.find((a) => a.startsWith("--"));
  if (bad !== undefined) {
    console.error(`${LABEL}: unknown flag: ${bad}`);
    return null;
  }
  const pr =
    args[0] ??
    (
      await ghOrExit(LABEL, ["pr", "view", "--json", "number", "-q", ".number"])
    ).trim();
  if (/^[0-9]+$/.test(pr)) return pr;
  console.error(`${LABEL}: PR must be a number (got '${pr}')`);
  return null;
}

/** The scanner check runs on the PR's head, and the head's short form. */
async function runsOnHead(
  pr: string,
  apps: readonly string[],
): Promise<{ runs: ScannerRun[]; head: string; slug: string }> {
  const slug = (
    await repoViewOrExit(LABEL, [
      "--json",
      "nameWithOwner",
      "-q",
      ".nameWithOwner",
    ])
  ).trim();
  const head = (
    await ghOrExit(LABEL, [
      "api",
      `repos/${slug}/pulls/${pr}`,
      "-q",
      ".head.sha",
    ])
  ).trim();
  const listed = await ghOrExit(
    LABEL,
    [
      "api",
      "--paginate",
      "--slurp",
      `repos/${slug}/commits/${head}/check-runs?per_page=100`,
    ],
    { deadlineFactor: 4 },
  );
  return { runs: scannerRuns(flatten(listed, "check_runs"), apps), head, slug };
}

/** The scanner apps to read: the configured ones, else the default; `null` when the configuration is invalid. */
function configuredApps(): readonly string[] | null {
  try {
    return reviewConfig().scanner_apps ?? DEFAULT_SCANNER_APPS;
  } catch (err) {
    console.error(`${LABEL}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** Print each finding of the runs that carry annotations. */
async function printFindings(slug: string, runs: ScannerRun[]): Promise<void> {
  for (const run of runs.filter((r) => r.annotations > 0)) {
    const raw = await ghOrExit(
      LABEL,
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${slug}/check-runs/${run.id}/annotations?per_page=100`,
      ],
      { deadlineFactor: 4 },
    );
    for (const finding of findingsOf(run, flatten(raw)))
      process.stdout.write(`${JSON.stringify(finding)}\n`);
  }
}

async function main(): Promise<number> {
  const pr = await targetPr(process.argv.slice(2));
  const apps = configuredApps();
  if (pr === null || apps === null) return 2;
  const { runs, head, slug } = await runsOnHead(pr, apps);
  await printFindings(slug, runs);
  if (runs.every((r) => r.completed)) return 0;
  console.error(
    `${LABEL}: a scanner check has not completed on ${head.slice(0, 12)}; its findings may not be listed yet`,
  );
  return 3;
}

if (import.meta.main) runMain(LABEL, main);
