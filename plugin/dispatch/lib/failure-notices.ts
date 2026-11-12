/**
 * The failure ledger's notifications (`failures.ts`), planned with each
 * repository's notifications from the rows earlier ticks wrote: a row whose
 * failures in a row reached `failures.notify_after` is one cause, keyed by
 * the row and the time its failures began, so one run of failures is one
 * cause, sent once and then on `dispatch.renotify_after`, and a later run is
 * a new one. The cause leaves the plan with its row, a success or its action
 * leaving the plan, and its suppression record goes the way every notice's
 * does.
 *
 * Only the host that owns a repository notifies for it, as for every cause.
 * An action's row is notified at its own repository. A repository's turn
 * and the tick as a whole are this host's, and may fail where nothing about
 * the repository can be told there, so their rows are notified at one
 * repository, the host's home: the first the machine file lists that this
 * host owns with `notify` enabled and whose own turn is not failing, else
 * the first it owns with `notify`. A failure of the host's own has one
 * identity wherever it is told: its notice key carries `host`, not the
 * destination's slug, and a delivery at any repository suppresses it at the
 * others (`hostNoticeKeys`).
 */
import { resolve } from "node:path";
import { stateRoot } from "../receipts.ts";
import {
  type FailureRow,
  type FailureSettings,
  isActionKind,
  readFailures,
} from "./failures.ts";
import { failureSettings, type MachineConfig } from "./machine-config.ts";
import { failingNotice } from "./notices.ts";
import type { TickContext } from "./tick-context.ts";
import type { OpenedRepo } from "./tick-observe.ts";
import type { Action, FailureCause, NotifyCause, RecordName } from "./types.ts";
import { isoFromMs } from "../../shared/time.ts";

const FAILURE_CAUSES: ReadonlySet<NotifyCause> = new Set<FailureCause>([
  "action-failing",
  "repository-failing",
  "ticks-failing",
]);

export function isFailureCause(cause: NotifyCause): cause is FailureCause {
  return FAILURE_CAUSES.has(cause);
}

/** Text that ends as a sentence does. */
function sentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

function times(n: number): string {
  return n === 1 ? "once" : `${n} times`;
}

/** What a row's action does, in words, and the record that wants it. */
function actionOf(row: FailureRow): { what: string; record: RecordName } {
  switch (row.kind) {
    case "label":
      return {
        what: `Writing the dispatch labels of ${row.target}`,
        record: "forge",
      };
    case "notice":
      return {
        what: `Delivering the notice ${row.key.replace(/^notice /, "")}`,
        record: "runtime",
      };
    case "nudge":
      return {
        what: `Nudging the waiting session of ${row.target}`,
        record: "runtime",
      };
    case "claim-end":
      return {
        what: `Writing the end of this host's launch claim on ${row.target}`,
        record: "forge",
      };
    default:
      return {
        what: `Writing the follow-up's answer on its marker on ${row.target}`,
        record: "forge",
      };
  }
}

const RECEIPT =
  "Each tick's receipt lists it under failures (`jig receipts dispatch`).";

/** What the key of a host failure's notice starts with, in place of a repository's slug. */
export const HOST_NOTICE = "host";

/** The notice keys of the rows of this host's own failures: those of its repositories' turns and of its ticks. */
export function hostNoticeKeys(rows: readonly FailureRow[]): Set<string> {
  return new Set(
    rows
      .filter((r) => r.kind === "tick" || r.kind === "repository")
      .map((r) => hostCause(HOST_NOTICE, r).notice?.key as string),
  );
}

/** The cause for one row past the threshold. */
function causeOf(
  slug: string,
  row: FailureRow,
  cause: FailureCause,
  record: RecordName,
  lines: string[],
): Action {
  // Every repository's row has the key `repository`: its path tells them apart.
  const what = row.kind === "repository" ? `repository ${row.repo}` : row.key;
  const key = `${what} failing since ${row.firstAt}`;
  return {
    stage: "notify",
    target: row.target,
    record,
    reason: `failed ${times(row.count)} in a row since ${row.firstAt}: ${row.reason}`,
    evidence: {
      failures: row.count,
      since: row.firstAt,
      last: row.reason,
      ...(isActionKind(row.kind)
        ? { row: row.key, next: isoFromMs(row.nextAtMs) }
        : {}),
    },
    cause,
    notice: failingNotice(slug, key, lines),
  };
}

/** The notification of an action's row past the threshold. */
function actionCause(slug: string, row: FailureRow): Action {
  const { what, record } = actionOf(row);
  return causeOf(slug, row, "action-failing", record, [
    `${what} has failed ${times(row.count)} in a row since ${row.firstAt}. The last failure: ${sentence(row.reason)}`,
    `The tick backs off between tries, the next at ${isoFromMs(row.nextAtMs)}, and keeps trying while the action is wanted; this notice retires once it succeeds or is no longer wanted. ${RECEIPT}`,
  ]);
}

/** The notification of a repository's or the tick's row past the threshold. */
function hostCause(slug: string, row: FailureRow): Action {
  if (row.kind === "repository")
    return causeOf(slug, row, "repository-failing", "runtime", [
      `The dispatcher's turn for ${row.target} has failed ${row.count === 1 ? "one tick" : `${row.count} ticks`} in a row since ${row.firstAt}. The last failure: ${sentence(row.reason)}`,
      `While it fails, whatever the failure keeps the tick from reading is neither launched nor labelled for it; this notice retires at the first tick that reads it whole. ${RECEIPT}`,
    ]);
  return causeOf(slug, row, "ticks-failing", "runtime", [
    `This host's dispatcher ${row.target} have exited 1 ${times(row.count)} in a row since ${row.firstAt}. The last failure: ${sentence(row.reason)}`,
    `Read the latest receipt and the tick's journal for what failed; this notice retires at the first such tick that exits 0. ${RECEIPT}`,
  ]);
}

/** The path of the repository this host notifies its own failures at; `null` when it owns none with `notify`. */
export function homeOf(
  machine: Pick<MachineConfig, "repositories">,
  rows: readonly FailureRow[],
): string | null {
  const candidates = machine.repositories.filter(
    (r) => r.owner && r.stages.includes("notify"),
  );
  const failing = new Set(
    rows.filter((r) => r.kind === "repository").map((r) => r.repo),
  );
  return (
    candidates.find((r) => !failing.has(r.path))?.path ??
    candidates[0]?.path ??
    null
  );
}

/**
 * The notifications the failure ledger asks of one repository's turn: its
 * actions' rows past the threshold, and at the host's home, the rows of the
 * repositories this host owns and of its ticks. A failure's own
 * notification is never notified again.
 */
export function failureCauses(
  slug: string,
  path: string,
  rows: readonly FailureRow[],
  machine: Pick<MachineConfig, "repositories" | "failures">,
): Action[] {
  const settings: FailureSettings = failureSettings(machine);
  const due = (r: FailureRow) => r.count >= settings.notifyAfter;
  const actions = rows
    .filter(
      (r) =>
        r.repo === slug &&
        isActionKind(r.kind) &&
        r.kind !== "failure-notice" &&
        due(r),
    )
    .map((r) => actionCause(slug, r));
  if (homeOf(machine, rows) !== resolve(path)) return actions;
  const owned = new Set(
    machine.repositories.filter((r) => r.owner).map((r) => r.path),
  );
  for (const r of rows)
    if (
      due(r) &&
      (r.kind === "tick" || (r.kind === "repository" && owned.has(r.repo)))
    )
      actions.push(hostCause(HOST_NOTICE, r));
  return actions;
}

/** The failure ledger's notifications for one opened repository, with `--apply` where this host notifies for it. */
export function planFailureNotices(
  context: TickContext,
  opened: OpenedRepo,
): Action[] {
  const machine = context.options.machine;
  if (
    context.apply === null ||
    machine == null ||
    !opened.owner ||
    !opened.stages.has("notify")
  )
    return [];
  const rows = readFailures(undefined, context.apply.root ?? stateRoot());
  return failureCauses(opened.repo.slug, opened.repo.path, rows, machine);
}
