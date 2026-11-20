/**
 * What a tick leaves behind for reading, once it has done its work: the
 * outcome log's text copy, and the line the dashboard shows
 * (`line.ts`, `line-store.ts`). Each that cannot be written is said on the
 * receipt and makes the tick's exit `1`; what the tick launched stands, and
 * the next tick writes both again.
 */
import { weightReport } from "./account-report.ts";
import { attempt, ok, type Outcome } from "../../shared/outcome.ts";
import { pluginVersion } from "../../shared/plugin-version.ts";
import {
  type CodexOptIn,
  lastAccount,
  notAdmitted,
  slotTable,
} from "./accounts.ts";
import { readNudges } from "./actions/steer.ts";
import type {
  LineAccount,
  LineDriver,
  LineSnapshot,
} from "./dashboard-contract.ts";
import {
  driversOf,
  type HostDriver,
  type HostDrivers,
  type UnrecordedDriver,
  unrecordedDrivers,
} from "./host-drivers.ts";
import type { ReadRecord } from "./launches.ts";
import {
  buildLine,
  type HoldSeen,
  type RepoLineInput,
  type RepoStored,
} from "./line.ts";
import {
  readLine,
  readLineReceipt,
  withLineLocked,
  writeLine,
} from "./line-store.ts";
import {
  identifiedSlugs,
  mergeLine,
  readBy,
  withLastSlugs,
} from "./line-merge.ts";
import { hostTimeZone } from "./host-time.ts";
import { keepTrackerPart } from "./line-keyless.ts";
import { keylessSystems } from "./no-credential.ts";
import { exportLog } from "./log-export.ts";
import type { MachineConfig } from "./machine-config.ts";
import type { SessionsReport } from "./runtime/port.ts";
import { inTransaction, stateDb } from "./state.ts";
import { insertRow } from "./log.ts";
import { firstSends } from "./notice-records.ts";
import {
  type ParkOutcomes,
  parkOutcomes,
  withUnreadRepos,
  type ParkRepo,
} from "./park-events.ts";
import { failureText } from "./text.ts";
import { tickHealthOf, withTick } from "./tick-health.ts";
import { readStateStorage, stateStorageNeeds } from "./state-storage-need.ts";
import { passTimeoutSeconds } from "../../skills/drive-pr/scripts/lib/driver/settings.ts";
import type { TickReceipt } from "../receipts.ts";
import type { ClaimedItem, DrivenPr, WantedItem } from "./types.ts";
import { type PrLinkText, workLinks } from "./work-links.ts";
import type { IssueKeys } from "../../skills/do-item/scripts/lib/tracker/keys.ts";
import { parseMs } from "../../shared/time.ts";

/** Copy the outcome log's new rows into its month files; false, with the reason on the receipt, when the copy failed. */
export function copyLog(receipt: TickReceipt): boolean {
  try {
    exportLog();
    return true;
  } catch (error) {
    receipt.logCopyFailed = `the outcome log's month files were not brought up to date, and the next tick copies the rows again: ${failureText(error)}`;
    return false;
  }
}

/** What a repository's reads add to its report for the line: its drives, each other target's title and link, its tracker, and, where `repo` names how its branches are named, what links its open pull requests to its items. */
export function lineInputOf(
  drives: DrivenPr[],
  forge: {
    ok?: boolean;
    open: ReadonlyArray<{ number: number; url: string; title: string }>;
    merged: ReadonlyArray<{ number: number; url: string; title: string }>;
    linkTexts?: PrLinkText[];
  },
  tracked: {
    pickups: WantedItem[];
    claimed: ClaimedItem[] | null;
    keys?: IssueKeys | null;
    adapter?: string | null;
    issueRepository?: string | null;
  },
  sessions: SessionsReport,
  repo: { slug: string; branchPattern: string } | null = null,
): RepoLineInput {
  const { keys, adapter } = tracked;
  return {
    drives,
    open: forge.ok === false ? null : forge.open.map((p) => p.number),
    known: [
      ...[...forge.open, ...forge.merged].map((p) => ({
        target: `PR #${p.number}`,
        title: p.title,
        url: p.url,
      })),
      ...tracked.pickups.map((p) => ({
        target: p.key,
        title: p.title,
        url: p.url,
      })),
      ...(tracked.claimed ?? []).map((c) => ({
        target: c.key,
        title: c.title,
        url: c.url ?? null,
      })),
    ],
    sessions,
    ...(adapter === undefined
      ? {}
      : {
          tracker:
            adapter === null
              ? null
              : {
                  adapter,
                  ...(tracked.issueRepository == null
                    ? {}
                    : { repository: tracked.issueRepository }),
                },
        }),
    links:
      repo === null || keys == null || forge.linkTexts === undefined
        ? null
        : workLinks(forge.linkTexts, {
            keys,
            branchPattern: repo.branchPattern,
            repository: repo.slug,
            issueRepository: tracked.issueRepository ?? null,
          }),
  };
}

/** What the state database holds for a repository's line. */
function storedFor(slug: string): RepoStored {
  const db = stateDb();
  return {
    nudges: [...readNudges(slug).values()],
    holds: db
      .query("SELECT pr, area, leader, since FROM holds WHERE repo = ?")
      .all(slug) as HoldSeen[],
    // When each cause was first told, on whichever channel told it first.
    notified: firstSends(db, slug),
  };
}

function accountsOf(
  machine: MachineConfig,
  records: ReadRecord[],
  nowMs: number,
  codexOptIn: CodexOptIn,
  weights?: import("./local-weights.ts").AccountWeights,
  drivers: readonly HostDriver[] = [],
): LineAccount[] {
  const refused = notAdmitted(
    machine.accounts,
    passTimeoutSeconds(),
    codexOptIn,
  );
  return slotTable(
    machine.accounts,
    records,
    nowMs,
    undefined,
    weights,
    drivers,
  ).map((slots) => ({
    name: slots.account.name,
    weight: weightReport(
      slots,
      refused.find((r) => r.account === slots.account.name)?.reason ?? null,
    ),
    vendor: slots.account.vendor,
    cap: slots.account.maxPerAccount,
    held: slots.held,
    ...(slots.account.stages === undefined
      ? {}
      : { stages: [...slots.account.stages] }),
    wall:
      slots.wall === null
        ? null
        : { resetAt: slots.wall.resetAt, source: slots.wall.source },
    wallUnrecorded: slots.wallUnrecorded,
    notAdmitted:
      refused.find((r) => r.account === slots.account.name)?.reason ?? null,
  }));
}

/** The line's drivers, or why they could not be read; nothing for a tick that did not read them. */
function driversPart(
  machine: MachineConfig,
  records: ReadRecord[],
  drivers: HostDrivers | undefined,
):
  | { drivers: LineDriver[] }
  | { driversUnread: string }
  | Record<never, never> {
  if (drivers === undefined) return {};
  if (!drivers.ok) return { driversUnread: drivers.failure.reason };
  return {
    drivers: lineDrivers(
      unrecordedDrivers(machine.accounts, records, drivers.value),
    ),
  };
}

/** Each driver no holding record accounts for, as the line lists it. */
function lineDrivers(drivers: UnrecordedDriver[]): LineDriver[] {
  return drivers.map(
    ({ driver, account, accountReason, startedBy, record }) => ({
      pr: driver.pr,
      worktree: driver.worktree,
      account,
      accountReason,
      identity: driver.identity,
      vendor: driver.vendor,
      startedBy,
      record,
      pid: driver.pid,
      since: driver.since,
      log: driver.log,
    }),
  );
}

/** The line with its parks, and the event rows of the parks that left: the rows and the line that records them as ingested land together. */
function writeWithParks(
  line: LineSnapshot,
  parked: ParkOutcomes,
  receipt: string,
): void {
  const db = stateDb();
  inTransaction(db, () => {
    for (const row of parked.rows) insertRow(db, row);
    writeLine(
      { ...line, parks: parked.parks, ingested: parked.ingested },
      receipt,
    );
  });
}

/** Each repository the tick read, as the park outcomes compare it: its owner flag, its open pull requests and its drives. */
function parkRepos(
  receipt: TickReceipt,
  machine: MachineConfig,
  inputs: Map<string, RepoLineInput>,
): ParkRepo[] {
  return receipt.repos.flatMap((report) => {
    const input = inputs.get(report.path);
    if (report.slug === null) return [];
    // A repository whose forge was not read keeps the parks it held.
    return [
      {
        slug: report.slug,
        owner:
          machine.repositories.find((r) => r.path === report.path)?.owner ??
          false,
        open: input?.open ?? null,
        drives: input?.drives ?? [],
        finalParks: input?.finalParks ?? [],
      },
    ];
  });
}

/** Whether `repos` are every repository the machine file lists, and only those. */
function readsTheMachine(machine: MachineConfig, repos: string[]): boolean {
  const listed = new Set(machine.repositories.map((r) => r.path));
  const named = new Set(repos);
  return named.size === listed.size && [...named].every((r) => listed.has(r));
}

/** Add health to the previous snapshot without replacing its state or receipt. */
function addTick(receipt: TickReceipt, sweep: boolean): Outcome<void> {
  const locked = attempt(
    "line-unwritten",
    "the dashboard's recent ticks were not brought up to date",
    () => withLineLocked(() => addTickLocked(receipt, sweep)),
  );
  return locked.ok ? locked.value : locked;
}

function addTickLocked(receipt: TickReceipt, sweep: boolean): Outcome<void> {
  const previous = readLine();
  if (!previous.ok) return previous;
  if (previous.value === null) return ok(undefined);
  const stored = readLineReceipt();
  if (!stored.ok) return stored;
  if (stored.value?.runId !== previous.value.runId)
    return {
      ok: false,
      failure: {
        code: "line-unreadable",
        reason: "the dashboard's line changed while its receipt was read",
      },
    };
  const line = previous.value;
  const receiptText = stored.value.receipt;
  return attempt(
    "line-unwritten",
    "the dashboard's recent ticks were not brought up to date",
    () =>
      writeLine(
        { ...line, ticks: withTick(line.ticks, tickHealthOf(receipt, sweep)) },
        receiptText,
      ),
  );
}

/** The line with the host's load the tick read, when it read one. */
function withLoad(line: LineSnapshot, receipt: TickReceipt): LineSnapshot {
  return receipt.load === undefined ? line : { ...line, load: receipt.load };
}

/** Keep a partial or failed tick in history, preserving the last complete snapshot. */
export function recordTickHealth(
  receipt: TickReceipt,
  machine: MachineConfig,
): void {
  const added = addTick(
    receipt,
    readsTheMachine(
      machine,
      receipt.repos.map((repo) => repo.path),
    ),
  );
  if (added.ok) return;
  receipt.lineFailed = added.failure.reason;
  receipt.exitStatus = 1;
}

/**
 * Write the line of a finished tick from the machine file. A tick that read
 * every repository replaces the line. One that read only some replaces their
 * part of the line and keeps every other repository's from the line before
 * (`line-merge.ts`); it also writes the machine's part (the accounts, the
 * line's own tick, the receipt beside it) when the timer asked it for every
 * repository and another tick held the rest, and leaves that part as it was
 * when a wake-up asked it for a few. One that read none of them, and was
 * not asked for every repository, adds itself to the line's recent ticks and
 * leaves the rest. The tick's own work is done
 * and depends on none of this, so what throws here, a bug included, becomes
 * the reason on the receipt rather than a stop.
 */
export function writeTickLine(
  receipt: TickReceipt,
  tick: {
    machine: MachineConfig | null;
    /** The repositories the tick was asked for. */
    asked: string[];
    /** Those it read: the asked ones another tick did not hold. */
    repos: string[];
    records: ReadRecord[];
    inputs: Map<string, RepoLineInput>;
    /** The admission decision the tick launched under, so line and launches agree. */
    codexOptIn: CodexOptIn;
    weights?: import("./local-weights.ts").AccountWeights | undefined;
    /** The host's live drivers, as the tick read them. */
    drivers?: HostDrivers | undefined;
  },
): void {
  const { machine } = tick;
  if (machine === null) return;
  const listed = new Set(machine.repositories.map((r) => r.path));
  const reports = receipt.repos.filter((r) => listed.has(r.path));
  const whole = readsTheMachine(machine, tick.repos);
  const writesMachine = whole || readsTheMachine(machine, tick.asked);
  // A timer tick that found every repository held still writes the machine's part: it is the timer's heartbeat.
  if (!writesMachine && reports.length === 0) {
    recordTickHealth(receipt, machine);
    return;
  }
  const storage = writesMachine ? readStateStorage() : undefined;
  const locked = attempt(
    "line-unwritten",
    "the dashboard's line was not written, so it keeps showing the tick before",
    () => withLineLocked(() => writeKept(receipt, tick, whole, storage)),
  );
  if (locked.ok) return;
  receipt.lineFailed = locked.failure.reason;
  receipt.exitStatus = 1;
}

/** The merge of the line before with this tick's, read and written under the line's write lock. */
function writeKept(
  receipt: TickReceipt,
  tick: Parameters<typeof writeTickLine>[1],
  whole: boolean,
  storage: ReturnType<typeof readStateStorage> | undefined,
): void {
  const { machine, records } = tick;
  if (machine === null) return;
  const reports = receipt.repos.filter((r) =>
    machine.repositories.some((m) => m.path === r.path),
  );
  const kept = keptMachine(
    whole,
    whole || readsTheMachine(machine, tick.asked),
    receipt.startedAt,
  );
  if (!kept.ok) {
    receipt.lineFailed = kept.failure.reason;
    receipt.exitStatus = 1;
    return;
  }
  const { before, receiptText } = kept.value;
  const written = attempt(
    "line-unwritten",
    "the dashboard's line was not written, so it keeps showing the tick before",
    () => {
      const fresh = readBy(
        buildLine({
          runId: receipt.runId,
          startedAt: receipt.startedAt,
          finishedAt: receipt.finishedAt,
          exitStatus: receipt.exitStatus,
          apply: receipt.apply,
          applyWithheld: receipt.applyWithheld ?? null,
          plugin: pluginVersion(),
          timeZone: hostTimeZone(),
          machine,
          reports,
          inputs: tick.inputs,
          stored: storedFor,
          records,
          accounts: accountsOf(
            machine,
            records,
            parseMs(receipt.finishedAt),
            tick.codexOptIn,
            tick.weights,
            driversOf(tick.drivers),
          ),
          hostDrivers: driversPart(machine, records, tick.drivers),
          lastAccount: lastAccount(records),
          previousNeeds: before?.needs ?? [],
          ...(receipt.quotaRisks === undefined
            ? {}
            : { quotaRisks: receipt.quotaRisks }),
          recentTicksMs: before?.recentTicksMs ?? [],
        }),
        receipt.runId,
        receipt.startedAt,
      );
      // Even a whole tick merges: another tick may have written a newer part since this one read.
      // A tracker the tick had no credential for leaves its repositories' tracker part as last read with one.
      const line = keepTrackerPart(
        withLastSlugs(
          before === null
            ? fresh
            : mergeLine(
                before,
                fresh,
                machine.repositories,
                receiptText === null ? "fresh" : "kept",
              ),
          before,
        ),
        before,
        { runId: receipt.runId, systems: keylessSystems(receipt) },
      );
      if (receiptText === null && storage !== undefined) {
        const remaining = line.needs.filter(
          (need) => need.cause !== "state-storage",
        );
        line.needs = [
          ...remaining,
          ...stateStorageNeeds(
            storage,
            before?.needs ?? [],
            receipt.finishedAt,
          ),
        ];
      }
      const ticks = withTick(before?.ticks, tickHealthOf(receipt, whole));
      const listedSlugs = identifiedSlugs(line, before, machine.repositories);
      const slugsOf = (current: boolean): Set<string> =>
        current
          ? new Set(
              line.repos.flatMap((r) =>
                r.slug === null || r.runId !== receipt.runId ? [] : [r.slug],
              ),
            )
          : listedSlugs;
      const accepted = slugsOf(true);
      const parked = withUnreadRepos(
        parkOutcomes(
          parkRepos(receipt, machine, tick.inputs).filter((r) =>
            accepted.has(r.slug),
          ),
          before ?? {},
          receipt.finishedAt,
        ),
        accepted,
        slugsOf(false),
        before ?? {},
      );
      writeWithParks(
        withLoad({ ...line, ticks }, receipt),
        parked,
        receiptText ?? JSON.stringify(receipt, null, 2),
      );
    },
  );
  if (written.ok) return;
  receipt.lineFailed = written.failure.reason;
  receipt.exitStatus = 1;
}

/**
 * The line before this tick's, and, when this tick does not write the
 * machine's part (`writes` false), the receipt kept beside that line, which
 * the line keeps too. A tick that read only some repositories (`whole`
 * false) needs the line before to keep the others' parts, so one that does
 * not read fails it.
 */
function keptMachine(
  whole: boolean,
  writes: boolean,
  startedAt: string,
): Outcome<{ before: LineSnapshot | null; receiptText: string | null }> {
  const previous = readLine();
  if (!previous.ok)
    return whole ? ok({ before: null, receiptText: null }) : previous;
  const before = previous.value;
  // A line whose tick started after this one holds the newer machine part: keep it.
  const newer = before !== null && before.startedAt > startedAt;
  if ((writes && !newer) || before === null)
    return ok({ before, receiptText: null });
  const stored = readLineReceipt();
  if (!stored.ok) return stored;
  if (stored.value?.runId !== before.runId)
    return {
      ok: false,
      failure: {
        code: "line-unreadable",
        reason: "the dashboard's line changed while its receipt was read",
      },
    };
  return ok({ before, receiptText: stored.value.receipt });
}
