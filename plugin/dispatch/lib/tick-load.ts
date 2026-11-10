/**
 * The load factor's part of a tick's act phase, under the act lock: the
 * host read once (`load-read.ts`), each running session's memory recorded
 * as a sample of its kind (`load-samples.ts`), and the load state the
 * launches are admitted against built from both (`load.ts`).
 */
import { attempt, type Outcome } from "../../shared/outcome.ts";
import { passTimeoutSeconds } from "../../skills/drive-pr/scripts/lib/driver/settings.ts";
import {
  type CodexOptIn,
  notAdmitted,
  type Slots,
  slotTable,
} from "./accounts.ts";
import type { LoadKind } from "./dashboard-contract.ts";
import { holds, type LaunchRecord, type ReadRecord } from "./launches.ts";
import { accountsReading, loadState, type LoadState } from "./load.ts";
import { readLoad } from "./load-read.ts";
import { type LoadSample, readSamples, recordSamples } from "./load-samples.ts";
import type { MachineConfig } from "./machine-config.ts";
import type { TickBudget } from "./tick-reads.ts";

/** The kind of launch a record is: a re-arm or takeover is a drive pass. */
function kindOfRecord(record: LaunchRecord): LoadKind {
  if (record.action === "steward") return "steward";
  return record.action === "pickup" || record.action === "followup"
    ? record.action
    : "drive";
}

/** The running records that have a workspace, with its path. */
function running(
  records: readonly ReadRecord[],
): Array<{ record: LaunchRecord; path: string }> {
  return records.flatMap(({ record, state }) =>
    holds(state) && record.workspace !== null
      ? [{ record, path: record.workspace.path }]
      : [],
  );
}

/** Reservations whose sessions the host reading does not represent yet. */
export function outstandingReservations(
  records: readonly ReadRecord[],
  reading: ReturnType<typeof readLoad>,
  load: LoadState,
): number {
  return records.reduce((total, { record, state }) => {
    if (!holds(state)) return total;
    // Windows cannot attribute RSS to a workspace, but a pending record has
    // not started a process for the host reading to account for yet.
    if (
      record.workspace !== null &&
      reading.sessions === null &&
      state.kind !== "pending"
    )
      return total;
    const kind = kindOfRecord(record);
    const reserved =
      load.reservations.find((entry) => entry.kind === kind)?.bytes ?? 0;
    const represented =
      record.workspace === null
        ? 0
        : (reading.sessions?.get(record.workspace.path) ?? 0);
    return total + Math.max(reserved - represented, 0);
  }, 0);
}

/**
 * Read the host's gauges for this tick and build the load state; with
 * `sample`, the `--apply` tick's, first record each running session's
 * memory, so this tick's samples count toward the reservations.
 */
export function readTickLoad(input: {
  machine: MachineConfig;
  records: ReadRecord[];
  table?: Slots[];
  budget: TickBudget;
  codexOptIn: CodexOptIn;
  nowMs: number;
  sample: boolean;
}): Outcome<LoadState, "load-unread"> {
  return attempt("load-unread", "the host's load was not read", () => {
    const { machine, records, nowMs } = input;
    const sessions = running(records);
    const reading = readLoad(
      sessions.map((s) => s.path),
      machine.repositories.map((r) => r.path),
      input.budget,
    );
    if (input.sample && reading.sessions !== null) {
      const samples: LoadSample[] = sessions.flatMap(({ record, path }) => {
        const bytes = reading.sessions?.get(path) ?? 0;
        return bytes > 0
          ? [{ kind: kindOfRecord(record), record: record.id, bytes }]
          : [];
      });
      recordSamples(samples, nowMs);
    }
    const table = input.table ?? slotTable(machine.accounts, records, nowMs);
    const refused = notAdmitted(
      machine.accounts,
      passTimeoutSeconds(),
      input.codexOptIn,
    );
    const load = loadState(
      machine.load,
      reading,
      accountsReading(table, refused),
      readSamples(),
    );
    load.spentBytes = outstandingReservations(records, reading, load);
    return load;
  });
}
