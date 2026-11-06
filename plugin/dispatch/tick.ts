/**
 * One tick, under the tick lock: for each repository, read the records
 * (the dispatch section from the default branch, the tracker, the forge's
 * pull requests and their drive ledgers, the runtime's sessions), plan
 * wanted minus running, and report; then write the tick's receipt. Without
 * `--apply` a tick starts nothing: it reports what it would start, and why.
 * With it, the re-arms and takeovers a repository's machine-file entry
 * enables are launched within each account's cap (actions/drive.ts), its
 * follow-ups as headless passes the same way (actions/followup.ts), its
 * pickups where the runtime binds an interactive session to its account
 * (actions/pickup.ts), its nudges are
 * sent once per waiting episode (actions/steer.ts), and its notifications
 * are sent once per cause (actions/notify.ts); everything else is still
 * reported.
 *
 * Each repository's turn is its own module's (lib/tick-repo.ts), in
 * phases: observe (lib/tick-observe.ts), plan (lib/tick-plan.ts), the
 * outcome log (lib/tick-settle.ts), act (lib/tick-apply.ts) and the label
 * projection (lib/tick-labels.ts).
 *
 * Control runs in every tick, `--apply` or not: before the plan, each
 * running drive's unresolved threads are recorded at its ledger's round
 * and each waiting interactive session's wall is read (expectations.ts,
 * session-walls.ts), so the plan can report the stages that drift and the
 * sessions a nudge is due for; after it, each launch record that ended gets
 * its row in the outcome log (log.ts, log-ended.ts), in the transaction that
 * writes its end, before any expired record is removed. Every record the
 * tick keeps is a row of the state database (lib/state.ts); at the end of
 * the tick the outcome log's new rows are copied into its month files
 * (lib/log-export.ts).
 *
 * Where a repository turns dispatch labels on (lib/labels.ts), the open
 * pull requests are listed with their labels, a person's `hold` keeps
 * every stage off a pull request and `drive` asks for an arm, and, last,
 * each managed pull request's state label is set from its ledger
 * (lib/actions/labels.ts). With them off, no label is read or written.
 *
 * Another host may dispatch the same repository: every host's launch claims
 * and their ends are read beside this host's records, and with `--apply`
 * this host claims its own launches there and writes their ends
 * (lib/shared-launches.ts, lib/tick-shared.ts). Only the host that owns the
 * repository (`owner` in the machine file) notifies, writes the labels and
 * the history rows of what it did not launch.
 */
import { hostCodexOptIn } from "./lib/accounts.ts";
import { accountsReport, rotated } from "./lib/actions/launch.ts";
import { settleFollowups } from "./lib/followup-outcomes.ts";
import { readLaunches } from "./lib/launches.ts";
import type { MachineConfig } from "./lib/machine-config.ts";
import { orcaRuntime } from "./lib/runtime/orca.ts";
import type { SessionRuntime } from "./lib/runtime/port.ts";
import { applyState } from "./lib/tick-apply.ts";
import {
  allRecords,
  type TickContext,
  type TickOptions,
} from "./lib/tick-context.ts";
import { copyLog, writeTickLine } from "./lib/tick-line.ts";
import { gatherRepo } from "./lib/tick-repo.ts";
import { settleOutcomes } from "./lib/tick-settle.ts";
import {
  newRunId,
  pruneReceipts,
  type TickReceipt,
  takeTickLock,
  writeReceipt,
} from "./receipts.ts";

export type { TickOptions } from "./lib/tick-context.ts";

export type TickResult =
  | { held: string }
  | { receipt: TickReceipt; path: string };

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
    // An ended follow-up's outcome is written before its record can expire.
    settleFollowups(read.records);
    const attempt = applyState(
      options,
      runtime,
      read.records,
      now.getTime(),
      read.unreadable,
    );
    // `--apply` with a machine file that was then withheld says why.
    const withheld =
      attempt !== null && "withheld" in attempt ? attempt.withheld : undefined;
    const apply = attempt !== null && "tick" in attempt ? attempt : null;
    const receipt: TickReceipt = {
      version: 1,
      runId: newRunId(now),
      startedAt: now.toISOString(),
      finishedAt: now.toISOString(),
      completed: false,
      apply: apply !== null,
      exitStatus: 0,
      ...(withheld === undefined ? {} : { applyWithheld: withheld }),
      ...accountsReport(machine, apply),
      unreadableLaunches: read.unreadable,
      repos: [],
    };
    const context: TickContext = {
      options,
      runtime,
      nowMs: now.getTime(),
      launches: apply?.records ?? read.records,
      apply,
      lineInputs: new Map(),
    };
    const order =
      apply === null ? options.repos : rotated(apply, options.repos);
    for (const path of order)
      receipt.repos.push(await gatherRepo(path, context));
    const failed = await settleOutcomes(receipt, context, days);
    const copied = copyLog(receipt);
    receipt.exitStatus = failed || !copied || withheld !== undefined ? 1 : 0;
    receipt.completed = true;
    receipt.finishedAt = new Date().toISOString();
    writeTickLine(receipt, {
      machine,
      repos: options.repos,
      records: allRecords(context),
      inputs: context.lineInputs,
      codexOptIn: apply?.codexOptIn ?? hostCodexOptIn(),
    });
    const path = writeReceipt(receipt);
    pruneReceipts(Date.now(), undefined, days);
    return { receipt, path };
  } finally {
    lock.release();
  }
}
