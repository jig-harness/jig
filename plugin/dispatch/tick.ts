/**
 * One tick, under the tick lock: for each repository, read the records
 * (the dispatch section from the default branch, the tracker, the forge's
 * pull requests and their drive ledgers, the runtime's sessions), plan
 * wanted minus running, and report; then write the tick's receipt. Without
 * `--apply` a tick starts nothing: it reports what it would start, and why.
 * With it, the re-arms and takeovers a repository's machine-file entry
 * enables are launched within each account's cap (actions/drive.ts), and
 * its pickups too where the runtime binds an interactive session to its
 * account (actions/pickup.ts); everything else is still reported.
 */
import { resolveLogin } from "../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import { parseTrackerConfig } from "../skills/do-item/scripts/lib/tracker/config.ts";
import { openTracker } from "../skills/do-item/scripts/lib/tracker/index.ts";
import {
  type IssueKeys,
  issueKeysOf,
} from "../skills/do-item/scripts/lib/tracker/keys.ts";
import {
  defaultBranchConfig,
  mergedSince,
  openPullRequests,
  repoTarget,
} from "./lib/forge.ts";
import type { Tracker } from "../skills/do-item/scripts/lib/tracker/port.ts";
import { type ApplyState, applyDrives } from "./lib/actions/drive.ts";
import { applyPickups } from "./lib/actions/pickup.ts";
import { releaseEnded, settleAgents } from "./lib/actions/pickup-hold.ts";
import { lastAccount, slotTable } from "./lib/accounts.ts";
import { readIdle, updateIdle } from "./lib/idle.ts";
import {
  pruneLaunches,
  readLaunches,
  type ReadRecord,
} from "./lib/launches.ts";
import { type MachineConfig, machineRepository } from "./lib/machine-config.ts";
import { type PlanInput, planTick } from "./lib/plan.ts";
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
import type {
  ClaimedItem,
  DispatchSection,
  MergedPr,
  RepoReport,
  RepoTarget,
  WantedItem,
} from "./lib/types.ts";
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

  const tracked = await readTracker(values, repo, section, report, where);
  const { keys } = tracked;

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
  const join: JoinTargets = {
    keys,
    branchPattern: branchPattern(values),
    pullRequests: [
      ...open.map((p) => ({ number: p.number, head: p.headRefName })),
      ...merged.map((p) => ({ number: p.number, head: p.head })),
    ],
  };
  const sessions = await readSessions(runtime, repo, join);
  report.records.push({
    record: "runtime",
    source: `${runtime.name}: ${sessions.source}`,
    ok: sessions.ok,
    detail: `${
      sessions.ok
        ? `${sessions.workspaces.length} workspace(s) of ${repo.slug}`
        : sessions.reason
    }${bindingNote(runtime, section)}`,
  });

  planRepo(context, repo.slug, report, {
    section,
    pickups: tracked.pickups,
    claimed: tracked.claimed,
    drives,
    merged,
    sessions,
  });
  const apply = context.apply;
  if (apply === null) return report;
  if (entry?.stages.includes("rearm"))
    await applyDrives(apply, repo, report, sessions, async (pr) => {
      const listed = open.filter((p) => p.number === pr);
      const [again] = await readDrives(repo.slug, login, listed, Date.now());
      return again ?? null;
    });
  if (entry?.stages.includes("pickup") && tracked.tracker !== null && keys)
    await applyPickups(apply, repo, report, {
      section,
      tracker: tracked.tracker,
      keys,
      branchPattern: join.branchPattern,
      sessions: () => readSessions(runtime, repo, join),
    });
  return report;
}

/** What the tracker gives one repository's tick. */
interface Tracked {
  keys: IssueKeys | null;
  pickups: WantedItem[];
  /** `null` when the claimed items could not be read. */
  claimed: ClaimedItem[] | null;
  /** The tracker opened for the read, for the pickups' fresh reads; `null` when none was. */
  tracker: Tracker | null;
}

/** The tracker's part of a repository's tick: the pickups wanted, and the items claimed. */
async function readTracker(
  values: Record<string, unknown>,
  repo: RepoTarget,
  section: DispatchSection,
  report: RepoReport,
  where: string,
): Promise<Tracked> {
  const tracked: Tracked = {
    keys: null,
    pickups: [],
    claimed: null,
    tracker: null,
  };
  try {
    const parsed = parseTrackerConfig(values);
    // GitHub Issues with no repository named are the forge repository's own.
    const config =
      parsed.adapter === "github" && parsed.github.repository === null
        ? { ...parsed, github: { ...parsed.github, repository: repo.slug } }
        : parsed;
    tracked.keys = issueKeysOf(config);
    const reading = await readPickups(() => {
      tracked.tracker = openTracker(config, repo.path);
      return tracked.tracker;
    }, section);
    report.records.push(reading.read);
    report.unplaced.push(...reading.unplaced);
    tracked.pickups = reading.wanted;
    if (reading.read.ok) tracked.claimed = reading.claimed;
  } catch (error) {
    report.records.push({
      record: "tracker",
      source: where,
      ok: false,
      detail: `the tracker cannot be opened: ${failureText(error)}`,
    });
  }
  return tracked;
}

/**
 * Plan one repository's tick into its report, with this machine's launch
 * records read beside the sessions; then keep the idle clock and release
 * the ended pickups whose item left the dispatch states, when the claimed
 * items were read whole.
 */
function planRepo(
  context: TickContext,
  repo: string,
  report: RepoReport,
  input: Omit<PlanInput, "launches" | "idleSince" | "nowMs">,
): void {
  const { nowMs } = context;
  const records = settleRecords(context, repo, input.sessions, nowMs);
  const plan = planTick({
    ...input,
    launches: records,
    idleSince: readIdle(repo),
    nowMs,
  });
  report.actions.push(...plan.actions);
  report.running.push(...plan.running);
  report.unplaced.push(...plan.unplaced);
  report.quiet.push(...plan.quiet);
  if (input.claimed === null) return;
  updateIdle(repo, plan.idleNow, nowMs);
  releaseEnded(records, repo, new Set(input.pickups.map((p) => p.key)));
}

/** Why the pickups this repository wants can only be reported, when the runtime cannot bind them. */
function bindingNote(
  runtime: SessionRuntime,
  section: DispatchSection,
): string {
  const binding = runtime.interactiveBinding;
  return binding.ok || section.identity === null
    ? ""
    : `; pickups are reported only: ${binding.reason}`;
}

/**
 * This machine's launch records for `repo`, each pickup's read beside its
 * agent: one whose agent the runtime reports finished no longer holds its
 * slot, so the slot table is counted again.
 */
function settleRecords(
  context: TickContext,
  repo: string,
  sessions: SessionsReport,
  nowMs: number,
): ReadRecord[] {
  const all = context.apply?.records ?? context.launches;
  if (settleAgents(all, repo, sessions, nowMs) && context.apply !== null)
    context.apply.table = slotTable(
      context.apply.machine.accounts,
      context.apply.records,
      nowMs,
    );
  return all.filter((r) => r.record.repo === repo);
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
  | { held: string }
  | { receipt: TickReceipt; path: string };

function applyState(
  options: TickOptions,
  runtime: SessionRuntime,
  records: ReadRecord[],
  nowMs: number,
  unreadable: string[],
): ApplyState | null {
  const machine = options.machine ?? null;
  if (!options.apply || machine === null) return null;
  // A record that cannot be read may belong to a live wrapper, so its slot and
  // pull request cannot be told apart from a free one: launch nothing.
  if (unreadable.length > 0) return null;
  return {
    machine,
    runtime,
    records,
    table: slotTable(machine.accounts, records, nowMs),
    last: lastAccount(records),
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

/** Whether `--apply` was asked for with a machine file and then withheld. */
function refusedApply(options: TickOptions, apply: ApplyState | null): boolean {
  return options.apply === true && options.machine != null && apply === null;
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
    const apply = applyState(
      options,
      runtime,
      read.records,
      now.getTime(),
      read.unreadable,
    );
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
    receipt.exitStatus = failed || refusedApply(options, apply) ? 1 : 0;
    receipt.completed = true;
    receipt.finishedAt = new Date().toISOString();
    const path = writeReceipt(receipt);
    pruneReceipts(Date.now(), undefined, days);
    return { receipt, path };
  } finally {
    lock.release();
  }
}
