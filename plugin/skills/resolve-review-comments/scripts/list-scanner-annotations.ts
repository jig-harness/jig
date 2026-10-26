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
 * Each line: { app, checkRunId, path, line, startLine, level, title, message,
 *              url, fingerprint }
 *   - level → `warning` or `failure`; `notice` annotations are left out.
 *   - message → the annotation's message where it says more than the title.
 *   - url → the first https link in the message, as the annotation wrote it.
 *   - fingerprint → stable across heads (file and text, not line, with
 *     same-text findings in one file numbered in line order) and
 *     marker-safe: a deferral's `--fingerprint`.
 *
 * Usage: bun list-scanner-annotations.ts [PR_NUMBER]
 *   PR_NUMBER defaults to the PR for the current branch.
 *
 * Apps read: `review.scanner_apps` (GitHub App slugs), else `sonarqubecloud`.
 * A configured app is expected on the head; the default one is read where it
 * runs, and its absence is not an error.
 *
 * Exit codes: 0 every scanner check on the head analysed it, the head did not
 * move while listing, and the lines printed are all its findings (none
 * printed: the head is clean); 2 bad usage or configuration; 3 not settled
 * yet (a configured app has no check run on the head, a scanner check is
 * still running, or the head moved while listing), so the lines printed may
 * be partial: wait and list again; 4 a scanner check completed without
 * analysing the head (cancelled, skipped, timed out, …), so its findings are
 * unknown: re-run that check; 1 a response could not be read or contradicts
 * itself (an annotation list that does not hold the count its completed run
 * reports, a check-run listing that does not hold the total it reports, a
 * value GitHub does not define), or the head has more check suites
 * than GitHub lists check runs from; anything else is a failed `gh` call.
 */

import { runMain } from "../../../shared/cli.ts";
import { reviewConfig } from "../../../shared/consumer.ts";
import { ghOrExit, repoViewOrExit } from "./lib/gh.ts";
import {
  DEFAULT_SCANNER_APPS,
  exitFor,
  findingsOf,
  flatten,
  type Read,
  type ScannerFinding,
  type ScannerRun,
  scannerRuns,
  suitesCovered,
  unsettled,
} from "./lib/scanner-annotations.ts";

const LABEL = "list-scanner-annotations";

/** What is wrong with the arguments, `null` when nothing is. */
function usageError(args: string[]): string | null {
  const bad = args.find((a) => a.startsWith("--"));
  if (bad !== undefined) return `unknown flag: ${bad}`;
  return args.length > 1 ? `one PR at most (got ${args.join(" ")})` : null;
}

/** The PR argument, else the current branch's; `null` after a usage error. */
async function targetPr(args: string[]): Promise<string | null> {
  const usage = usageError(args);
  if (usage !== null) {
    console.error(`${LABEL}: ${usage}`);
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

async function headOf(slug: string, pr: string): Promise<string> {
  return (
    await ghOrExit(LABEL, [
      "api",
      `repos/${slug}/pulls/${pr}`,
      "-q",
      ".head.sha",
    ])
  ).trim();
}

/** The scanner check runs on `head`, once the listing is known to cover all of its check suites. */
async function runsOn(
  slug: string,
  head: string,
  apps: readonly string[],
): Promise<Read<ScannerRun[]>> {
  const suites = suitesCovered(
    await ghOrExit(LABEL, [
      "api",
      `repos/${slug}/commits/${head}/check-suites?per_page=1`,
      "-q",
      ".total_count",
    ]),
  );
  if (!suites.ok) return suites;
  const listed = flatten(
    await ghOrExit(
      LABEL,
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${slug}/commits/${head}/check-runs?per_page=100`,
      ],
      { deadlineFactor: 4 },
    ),
    "check_runs",
  );
  return listed.ok ? scannerRuns(listed.value, apps) : listed;
}

/** The scanner apps to read and whether they were configured; `null` when the configuration is invalid. */
function configuredApps(): {
  apps: readonly string[];
  configured: boolean;
} | null {
  try {
    const apps = reviewConfig().scanner_apps;
    return apps === undefined
      ? { apps: DEFAULT_SCANNER_APPS, configured: false }
      : { apps, configured: true };
  } catch (err) {
    console.error(`${LABEL}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

/** One run's findings. */
async function annotationsOf(
  slug: string,
  run: ScannerRun,
): Promise<Read<ScannerFinding[]>> {
  const items = flatten(
    await ghOrExit(
      LABEL,
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${slug}/check-runs/${run.id}/annotations?per_page=100`,
      ],
      { deadlineFactor: 4 },
    ),
  );
  return items.ok ? findingsOf(run, items.value) : items;
}

/** Prints the findings of each run that may carry annotations, stopping at the first that cannot be read. */
async function printFindings(
  slug: string,
  runs: ScannerRun[],
): Promise<Read<ScannerRun[]>> {
  for (const run of runs.filter((r) => r.annotations !== 0)) {
    const found = await annotationsOf(slug, run);
    if (!found.ok) return found;
    process.stdout.write(
      found.value.map((f) => `${JSON.stringify(f)}\n`).join(""),
    );
  }
  return { ok: true, value: runs };
}

/** The scanner runs on `head`, printing the findings of each that may carry annotations. */
async function listFindings(
  slug: string,
  head: string,
  apps: readonly string[],
): Promise<Read<ScannerRun[]>> {
  const runs = await runsOn(slug, head, apps);
  return runs.ok ? printFindings(slug, runs.value) : runs;
}

/** The exit for runs listed on `head`, once the head is read again. */
async function verdict(
  slug: string,
  pr: string,
  head: string,
  runs: ScannerRun[],
  config: { apps: readonly string[]; configured: boolean },
): Promise<number> {
  const reasons = unsettled(runs, config.apps, config.configured);
  const now = await headOf(slug, pr);
  if (now !== head)
    reasons.pending.push(
      `the head moved from ${head.slice(0, 12)} to ${now.slice(0, 12)}`,
    );
  for (const reason of [...reasons.pending, ...reasons.unanalysed])
    console.error(`${LABEL}: ${reason}`);
  return exitFor(reasons);
}

function unreadable(error: string): number {
  console.error(`${LABEL}: cannot read the scanner evidence: ${error}`);
  return 1;
}

async function main(): Promise<number> {
  const pr = await targetPr(process.argv.slice(2));
  const config = configuredApps();
  if (pr === null || config === null) return 2;
  const slug = (
    await repoViewOrExit(LABEL, [
      "--json",
      "nameWithOwner",
      "-q",
      ".nameWithOwner",
    ])
  ).trim();
  const head = await headOf(slug, pr);
  const runs = await listFindings(slug, head, config.apps);
  return runs.ok
    ? verdict(slug, pr, head, runs.value, config)
    : unreadable(runs.error);
}

if (import.meta.main) runMain(LABEL, main);
