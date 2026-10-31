/**
 * One tick, under the tick lock: for each repository, read the records
 * (the dispatch section from the default branch, the tracker, the forge's
 * pull requests and their drive ledgers, the runtime's sessions), plan
 * wanted minus running, and report; then write the tick's receipt. Without
 * `--apply` a tick starts nothing: it reports what it would start, and why.
 * With it, the re-arms and takeovers a repository's machine-file entry
 * enables are launched within each account's cap (actions/drive.ts), and
 * everything else is still reported.
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
import { type ApplyState, applyDrives } from "./lib/actions/drive.ts";
import { lastAccount, slotTable } from "./lib/accounts.ts";
import {
  pruneLaunches,
  readLaunches,
  type ReadRecord,
} from "./lib/launches.ts";
import { type MachineConfig, machineRepository } from "./lib/machine-config.ts";
import { planTick } from "./lib/plan.ts";
import { orcaRuntime } from "./lib/runtime/orca.ts";
import type {
  JoinTargets,
  SessionRuntime,
  SessionsReport,
} from "./lib/runtime/port.ts";
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
  /** Launch what the machine file enables; needs `machine`. */
  apply?: boolean;
  machine?: MachineConfig | null;
  now?: Date;
  runtime?: SessionRuntime;
}

/** What one repository's gathering needs beyond its path. */
interface TickContext {
  options: TickOptions;
  runtime: SessionRuntime;
  nowMs: number;
  launches: ReadRecord[];
  apply: ApplyState | null;
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
    launches: [],
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
  context: TickContext,
): Promise<RepoReport> {
  const { options, runtime, nowMs } = context;
  const entry = machineRepository(options.machine ?? null, path);
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
      entry?.followupSince ??
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
  let login: string | null = null;
  try {
    open = await openPullRequests(repo.slug);
    login = await resolveLogin();
    drives = await readDrives(repo.slug, login, open, nowMs);
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
  const sessions = await readSessions(runtime, repo, {
    keys,
    branchPattern: branchPattern(values),
    pullRequests: [
      ...open.map((p) => ({ number: p.number, head: p.headRefName })),
      ...merged.map((p) => ({ number: p.number, head: p.head })),
    ],
  });
  report.records.push({
    record: "runtime",
    source: `${runtime.name}: ${sessions.source}`,
    ok: sessions.ok,
    detail: sessions.ok
      ? `${sessions.workspaces.length} workspace(s) of ${repo.slug}`
      : sessions.reason,
  });

  const plan = planTick({
    section,
    pickups,
    drives,
    merged,
    sessions,
    launches: (context.apply?.records ?? context.launches).filter(
      (r) => r.record.repo === repo.slug,
    ),
  });
  report.actions.push(...plan.actions);
  report.running.push(...plan.running);
  report.unplaced.push(...plan.unplaced);
  report.quiet.push(...plan.quiet);
  if (context.apply !== null && entry?.stages.includes("rearm"))
    await applyDrives(context.apply, repo, report, sessions, async (pr) => {
      const listed = open.filter((p) => p.number === pr);
      const [again] = await readDrives(repo.slug, login, listed, Date.now());
      return again ?? null;
    });
  return report;
}

/** The runtime's answer; a rejected read is a failed report, never an escape. */
async function readSessions(
  runtime: SessionRuntime,
  repo: RepoTarget,
  join: JoinTargets,
): Promise<SessionsReport> {
  try {
    return await runtime.sessions(repo, join);
  } catch (error) {
    return {
      ok: false,
      source: runtime.name,
      reason: `the runtime could not be read: ${failureText(error)}`,
    };
  }
}

export type TickResult =
  { held: string } | { receipt: TickReceipt; path: string };

function applyState(
  options: TickOptions,
  runtime: SessionRuntime,
  records: ReadRecord[],
  nowMs: number,
): ApplyState | null {
  const machine = options.machine ?? null;
  if (!options.apply || machine === null) return null;
  return {
    machine,
    runtime,
    records,
    table: slotTable(machine.accounts, records, nowMs),
    last: lastAccount(records),
    identities: new Map(),
  };
}

function defaultRuntime(machine: MachineConfig | null): SessionRuntime {
  return machine === null
    ? orcaRuntime()
    : orcaRuntime({
        runtimeTimeoutMs: machine.runtimeTimeoutMs,
        workspaceTimeoutMs: machine.workspaceTimeoutMs,
      });
}

export async function runTick(options: TickOptions): Promise<TickResult> {
  const lock = takeTickLock();
  if ("heldBy" in lock) return { held: lock.heldBy };
  try {
    const now = options.now ?? new Date();
    const machine = options.machine ?? null;
    const runtime = options.runtime ?? defaultRuntime(machine);
    const read = await readLaunches();
    const days = machine?.receiptsDays;
    pruneLaunches(read.records, now.getTime(), days ?? 30);
    // A record that cannot be read may belong to a live wrapper, so its slot
    // and pull request cannot be told apart from a free one: launch nothing.
    const unsafe = read.unreadable.length > 0;
    const apply = unsafe
      ? null
      : applyState(options, runtime, read.records, now.getTime());
    const receipt: TickReceipt = {
      version: 1,
      runId: newRunId(now),
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      completed: false,
      apply: apply !== null,
      exitStatus: 0,
      unreadableLaunches: read.unreadable,
      repos: [],
    };
    const context: TickContext = {
      options,
      runtime,
      nowMs: now.getTime(),
      launches: apply?.records ?? read.records,
      apply,
    };
    for (const path of options.repos)
      receipt.repos.push(await gatherRepo(path, context));
    const failed = receipt.repos.some(
      (r) => r.refused !== null || r.records.some((x) => !x.ok),
    );
    receipt.exitStatus =
      failed || (unsafe && options.apply === true && machine !== null) ? 1 : 0;
    receipt.completed = true;
    receipt.finishedAt = new Date().toISOString();
    const path = writeReceipt(receipt);
    pruneReceipts(Date.now(), undefined, days);
    return { receipt, path };
  } finally {
    lock.release();
  }
}
