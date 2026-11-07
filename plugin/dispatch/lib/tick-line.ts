/**
 * What a tick leaves behind for reading, once it has done its work: the
 * outcome log's text copy, and the line the dashboard shows
 * (`line.ts`, `line-store.ts`). Each that cannot be written is said on the
 * receipt and makes the tick's exit `1`; what the tick launched stands, and
 * the next tick writes both again.
 */
import { attempt, ok, type Outcome } from "../../shared/outcome.ts";
import { pluginVersion } from "../../shared/plugin-version.ts";
import {
  type CodexOptIn,
  lastAccount,
  notAdmitted,
  slotTable,
} from "./accounts.ts";
import { readNudges } from "./actions/steer.ts";
import type { LineAccount } from "./dashboard-contract.ts";
import type { ReadRecord } from "./launches.ts";
import {
  buildLine,
  type HoldSeen,
  type RepoLineInput,
  type RepoStored,
} from "./line.ts";
import { readLine, readLineReceipt, writeLine } from "./line-store.ts";
import { hostTimeZone } from "./host-time.ts";
import { exportLog } from "./log-export.ts";
import type { MachineConfig } from "./machine-config.ts";
import type { SessionsReport } from "./runtime/port.ts";
import { stateDb } from "./state.ts";
import { failureText } from "./text.ts";
import { tickHealthOf, withTick } from "./tick-health.ts";
import { passTimeoutSeconds } from "../../skills/drive-pr/scripts/lib/driver/settings.ts";
import type { TickReceipt } from "../receipts.ts";
import type { ClaimedItem, DrivenPr, WantedItem } from "./types.ts";

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

/** What a repository's reads add to its report for the line: its drives, and each other target's title and link. */
export function lineInputOf(
  drives: DrivenPr[],
  forge: {
    open: ReadonlyArray<{ number: number; url: string; title: string }>;
    merged: ReadonlyArray<{ number: number; url: string; title: string }>;
  },
  tracked: { pickups: WantedItem[]; claimed: ClaimedItem[] | null },
  sessions: SessionsReport,
): RepoLineInput {
  return {
    drives,
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
        url: null,
      })),
    ],
    sessions,
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
    notified: new Map(
      (
        db
          .query("SELECT key, at FROM notices WHERE repo = ?")
          .all(slug) as Array<{
          key: string;
          at: string;
        }>
      ).map((n) => [n.key, n.at]),
    ),
  };
}

function accountsOf(
  machine: MachineConfig,
  records: ReadRecord[],
  nowMs: number,
  codexOptIn: CodexOptIn,
): LineAccount[] {
  const refused = notAdmitted(
    machine.accounts,
    passTimeoutSeconds(),
    codexOptIn,
  );
  return slotTable(machine.accounts, records, nowMs).map((slots) => ({
    name: slots.account.name,
    vendor: slots.account.vendor,
    cap: slots.account.maxPerAccount,
    held: slots.held,
    wall:
      slots.wall === null
        ? null
        : { resetAt: slots.wall.resetAt, source: slots.wall.source },
    wallUnrecorded: slots.wallUnrecorded,
    notAdmitted:
      refused.find((r) => r.account === slots.account.name)?.reason ?? null,
  }));
}

/** Whether a tick read every repository the machine file lists, and only those: a tick for one repository would replace the whole line with that one. */
function readsTheMachine(machine: MachineConfig, repos: string[]): boolean {
  const listed = new Set(machine.repositories.map((r) => r.path));
  return repos.length === listed.size && repos.every((r) => listed.has(r));
}

/** Add health to the previous snapshot without replacing its state or receipt. */
function addTick(receipt: TickReceipt): Outcome<void> {
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
        { ...line, ticks: withTick(line.ticks, tickHealthOf(receipt, false)) },
        receiptText,
      ),
  );
}

/** Keep a partial or failed tick in history, preserving the last complete snapshot. */
export function recordTickHealth(receipt: TickReceipt): void {
  const added = addTick(receipt);
  if (added.ok) return;
  receipt.lineFailed = added.failure.reason;
  receipt.exitStatus = 1;
}

/**
 * Write the line of a finished tick from the machine file; a tick that read
 * only some of its repositories adds itself to the line's recent ticks and
 * leaves the rest. The tick's own work is done and depends on none of this,
 * so what throws here, a bug included, becomes the reason on the receipt
 * rather than a stop.
 */
export function writeTickLine(
  receipt: TickReceipt,
  tick: {
    machine: MachineConfig | null;
    repos: string[];
    records: ReadRecord[];
    inputs: Map<string, RepoLineInput>;
    /** The admission decision the tick launched under, so line and launches agree. */
    codexOptIn: CodexOptIn;
  },
): void {
  const { machine, records } = tick;
  if (machine === null) return;
  if (!readsTheMachine(machine, tick.repos)) {
    recordTickHealth(receipt);
    return;
  }
  const written = attempt(
    "line-unwritten",
    "the dashboard's line was not written, so it keeps showing the tick before",
    () => {
      const previous = readLine();
      const line = buildLine({
        runId: receipt.runId,
        startedAt: receipt.startedAt,
        finishedAt: receipt.finishedAt,
        exitStatus: receipt.exitStatus,
        apply: receipt.apply,
        applyWithheld: receipt.applyWithheld ?? null,
        plugin: pluginVersion(),
        timeZone: hostTimeZone(),
        machine,
        reports: receipt.repos,
        inputs: tick.inputs,
        stored: storedFor,
        records,
        accounts: accountsOf(
          machine,
          records,
          Date.parse(receipt.finishedAt),
          tick.codexOptIn,
        ),
        lastAccount: lastAccount(records),
        previousNeeds: previous.ok ? (previous.value?.needs ?? []) : [],
        recentTicksMs: previous.ok ? (previous.value?.recentTicksMs ?? []) : [],
      });
      const ticks = withTick(
        previous.ok ? previous.value?.ticks : undefined,
        tickHealthOf(receipt, true),
      );
      writeLine({ ...line, ticks }, JSON.stringify(receipt, null, 2));
    },
  );
  if (written.ok) return;
  receipt.lineFailed = written.failure.reason;
  receipt.exitStatus = 1;
}
