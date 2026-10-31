/**
 * One tick, under the tick lock: for each repository, read the records
 * (the dispatch section from the default branch, the tracker, the forge's
 * pull requests and their drive ledgers, the runtime's sessions), plan
 * wanted minus running, and report; then write the tick's receipt. A tick
 * starts nothing: it reports what it would start, and why.
 */
import { resolveLogin } from "../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { parseTrackerConfig } from "../skills/do-item/scripts/lib/tracker/config.ts";
import { openTracker } from "../skills/do-item/scripts/lib/tracker/index.ts";
import { issueKeysOf } from "../skills/do-item/scripts/lib/tracker/keys.ts";
import {
  defaultBranchConfig,
  mergedSince,
  openPullRequests,
  repoTarget,
} from "./lib/forge.ts";
import { planTick } from "./lib/plan.ts";
import { orcaRuntime } from "./lib/runtime/orca.ts";
import type { SessionRuntime } from "./lib/runtime/port.ts";
import { readSection } from "./lib/section.ts";
import { readDrives } from "./lib/sources/ledgers.ts";
import { readPickups } from "./lib/sources/tracker.ts";
import { failureText } from "./lib/text.ts";
import type { MergedPr, RepoReport, RepoTarget } from "./lib/types.ts";
import {
  newRunId,
  previousFollowupSince,
  pruneReceipts,
  type TickReceipt,
  takeTickLock,
  writeReceipt,
} from "./receipts.ts";

/** `pull_requests.branch_name`'s default, the branch form of an item. */
const BRANCH_PATTERN = "{key_lower}-{slug}";

export interface TickOptions {
  repos: string[];
  /** Overrides the follow-up window's start for every repository. */
  followupSince?: string;
  now?: Date;
  runtime?: SessionRuntime;
}

function emptyReport(path: string, refused: string): RepoReport {
  return {
    path,
    slug: null,
    refused,
    section: null,
    followupSince: null,
    records: [],
    actions: [],
    running: [],
    unplaced: [],
    quiet: [],
  };
}

function branchPattern(values: Record<string, unknown>): string {
  const prs = values.pull_requests;
  const pattern =
    typeof prs === "object" && prs !== null
      ? (prs as Record<string, unknown>).branch_name
      : undefined;
  return typeof pattern === "string" && pattern !== ""
    ? pattern
    : BRANCH_PATTERN;
}

async function gatherRepo(
  path: string,
  options: TickOptions,
  runtime: SessionRuntime,
  nowMs: number,
): Promise<RepoReport> {
  let repo: RepoTarget;
  try {
    repo = await repoTarget(path);
  } catch (error) {
    return emptyReport(
      path,
      `the forge cannot say which repository this is: ${failureText(error)}`,
    );
  }
  let read: ReturnType<typeof readSection>;
  const where = `${repo.slug}@${repo.defaultBranch}:.config/jig.yaml`;
  try {
    read = readSection(await defaultBranchConfig(repo), where);
  } catch (error) {
    return {
      ...emptyReport(
        path,
        `the dispatch section on the default branch cannot be read, so nothing is planned: ${failureText(error)}`,
      ),
      slug: repo.slug,
    };
  }
  const { values, section } = read;
  const report: RepoReport = {
    ...emptyReport(path, ""),
    refused: null,
    slug: repo.slug,
    section,
    followupSince:
      options.followupSince ??
      previousFollowupSince(path) ??
      new Date(nowMs).toISOString(),
  };

  // The tracker: the pickups wanted.
  let keys: ReturnType<typeof issueKeysOf> = null;
  let pickups: Awaited<ReturnType<typeof readPickups>>["wanted"] = [];
  try {
    const parsed = parseTrackerConfig(values);
    // GitHub Issues with no repository named are the forge repository's own.
    const config =
      parsed.adapter === "github" && parsed.github.repository === null
        ? { ...parsed, github: { ...parsed.github, repository: repo.slug } }
        : parsed;
    keys = issueKeysOf(config);
    const reading = await readPickups(() => openTracker(config, path), section);
    report.records.push(reading.read);
    report.unplaced.push(...reading.unplaced);
    pickups = reading.wanted;
  } catch (error) {
    report.records.push({
      record: "tracker",
      source: where,
      ok: false,
      detail: `the tracker cannot be opened: ${failureText(error)}`,
    });
  }

  // The forge: the open pull requests and their ledgers, and the merges.
  let open: Awaited<ReturnType<typeof openPullRequests>> = [];
  let drives: Awaited<ReturnType<typeof readDrives>> = [];
  let merged: MergedPr[] = [];
  try {
    open = await openPullRequests(repo.slug);
    drives = await readDrives(repo.slug, await resolveLogin(), open, nowMs);
    const since = report.followupSince as string;
    if (section.followupCommand !== null)
      merged = await mergedSince(repo.slug, since);
    report.records.push({
      record: "forge",
      source: `gh ${repo.slug}`,
      ok: true,
      detail: `${open.length} open pull request(s), ${drives.length} with a drive ledger; ${
        section.followupCommand === null
          ? "no dispatch.followup_command: no follow-ups"
          : `${merged.length} merged since ${since}`
      }`,
    });
  } catch (error) {
    report.records.push({
      record: "forge",
      source: `gh ${repo.slug}`,
      ok: false,
      detail: `the pull requests cannot be read: ${failureText(error)}`,
    });
    drives = [];
    merged = [];
  }

  // The runtime: which of them a session holds.
  const sessions = await runtime.sessions(repo, {
    keys,
    branchPattern: branchPattern(values),
    pullRequests: open.map((p) => ({ number: p.number, head: p.headRefName })),
  });
  report.records.push({
    record: "runtime",
    source: `${runtime.name}: ${sessions.source}`,
    ok: sessions.ok,
    detail: sessions.ok
      ? `${sessions.workspaces.length} workspace(s) of ${repo.slug}`
      : sessions.reason,
  });

  const plan = planTick({ section, pickups, drives, merged, sessions });
  report.actions.push(...plan.actions);
  report.running.push(...plan.running);
  report.unplaced.push(...plan.unplaced);
  report.quiet.push(...plan.quiet);
  return report;
}

export type TickResult =
  | { held: string }
  | { receipt: TickReceipt; path: string };

export async function runTick(options: TickOptions): Promise<TickResult> {
  const lock = takeTickLock();
  if ("heldBy" in lock) return { held: lock.heldBy };
  try {
    const now = options.now ?? new Date();
    const runtime = options.runtime ?? orcaRuntime();
    const receipt: TickReceipt = {
      version: 1,
      runId: newRunId(now),
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      completed: false,
      apply: false,
      exitStatus: 0,
      repos: [],
    };
    for (const path of options.repos)
      receipt.repos.push(
        await gatherRepo(path, options, runtime, now.getTime()),
      );
    const failed = receipt.repos.some(
      (r) => r.refused !== null || r.records.some((x) => !x.ok),
    );
    receipt.exitStatus = failed ? 1 : 0;
    receipt.completed = true;
    receipt.finishedAt = new Date().toISOString();
    const path = writeReceipt(receipt);
    pruneReceipts(Date.now());
    return { receipt, path };
  } finally {
    lock.release();
  }
}
