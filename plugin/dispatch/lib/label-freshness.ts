/**
 * The tick re-reads a pull request's ledger just before it writes its state
 * label. It projects each pull request's state from the ledger it read at
 * the start of its turn, and a drive writes its own label as soon as its
 * ledger changes (`shared/pr-labels/write.ts`): a write planned from the
 * earlier ledger would undo the drive's. So just before a state write on an
 * open pull request the tick reads the ledger again, and skips the write
 * when it changed since the tick read it, or no longer reads; the next tick
 * projects the ledger as it then is. A drive whose label write lands
 * between that re-read and the tick's own write can still be undone, until
 * the next tick.
 *
 * A ledger is the same when its generation, its driver's heartbeat (the time
 * of its last write), its driver's state and its exit are: every ledger write
 * moves the heartbeat.
 */
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { readLedgerSnapshot } from "../../skills/drive-pr/scripts/lib/state/ledger-forge.ts";
import type { Outcome } from "../../shared/outcome.ts";
import { failureFields } from "../../shared/errors.ts";
import { log } from "../../shared/log.ts";
import type { LabelChange } from "./labels.ts";
import { failureText } from "./text.ts";
import type { DrivenPr } from "./types.ts";

/** One ledger's identity: `null` for a pull request that carries none. */
type Mark = string | null;

function mark(
  generation: unknown,
  heartbeat: unknown,
  state: unknown,
  exit: unknown,
): string {
  return JSON.stringify([generation, heartbeat, state, exit ?? null]);
}

/** The mark of the ledger the tick read for `drive`, from what its classification kept. */
function readMark(drive: DrivenPr | undefined): Mark {
  if (drive === undefined || drive.class === "unarmed") return null;
  const e = drive.evidence;
  return mark(e.generation, e.heartbeat, e.driver, e.exit);
}

/** The mark of a ledger read now. */
function ledgerMark(ledger: Ledger | null): Mark {
  if (ledger === null) return null;
  return mark(
    ledger.generation,
    ledger.driver.heartbeat,
    ledger.driver.state,
    ledger.driver.exit,
  );
}

/** A pull request's ledger read again: the ledger, `null` for none, or why it does not read. */
export type LedgerReread = (pr: number) => Promise<Ledger | null | string>;

/** The ledger of pull request `pr` on `slug`, read from the forge now. */
export function forgeReread(slug: string, login: string | null): LedgerReread {
  return async (pr) => {
    const snapshot = await readLedgerSnapshot(String(pr), login, slug);
    if (typeof snapshot === "string") return snapshot;
    const canonical = snapshot.canonical;
    if (canonical === null)
      return snapshot.malformed.length > 0
        ? "its drive ledger comment does not read"
        : null;
    return canonical.parsed.kind === "ledger"
      ? canonical.parsed.ledger
      : "its drive ledger does not read";
  };
}

/** The labels of merged pull requests as the tick read them, and how to read one's now. */
export interface MergedLabels {
  read: ReadonlyMap<number, readonly string[]>;
  reread: (pr: number) => Promise<Outcome<string[], "unreadable">>;
}

/**
 * A merged pull request's state labels follow its follow-up markers, whose
 * labels are written apart from the tick (`marker done`, `marker failed`):
 * the change was planned from the labels the tick read, so it is written
 * only while they are still the labels now.
 */
async function mergedLabelsUnchanged(
  pr: number,
  read: readonly string[],
  reread: MergedLabels["reread"],
): Promise<string | null> {
  const now = await reread(pr);
  if (!now.ok)
    return `its labels did not read again before the write (${now.failure.reason}), so a later tick projects it`;
  const same =
    now.value.length === read.length &&
    now.value.every((label) => read.includes(label));
  return same
    ? null
    : "its labels changed since this tick read them, so a later tick projects it";
}

/**
 * The check `writeLabels` runs before each state write: why the write is
 * skipped this tick, or `null` to write it. Only an open pull request read
 * for a ledger is checked; a marker write and a merged pull request's state
 * are not.
 */
export function ledgerStillCurrent(
  open: ReadonlySet<number>,
  drives: readonly DrivenPr[],
  reread: LedgerReread,
  merged?: MergedLabels,
): (change: LabelChange) => Promise<string | null> {
  const byNumber = new Map(drives.map((d) => [d.number, d]));
  return async (change) => {
    if (change.part !== undefined) return null;
    const read = merged?.read.get(change.pr);
    if (merged !== undefined && read !== undefined)
      return await mergedLabelsUnchanged(change.pr, read, merged.reread);
    if (!open.has(change.pr)) return null;
    const drive = byNumber.get(change.pr);
    if (drive?.class === "unplaced") return null;
    let now: Ledger | null | string;
    try {
      now = await reread(change.pr);
    } catch (error) {
      // A throw here is a defect, not an unread ledger: logged with its stack, and the write waits.
      log.warn(
        `PR #${change.pr}: re-reading its drive ledger before a label write threw`,
        failureFields(error),
      );
      return `re-reading its drive ledger hit a defect (${failureText(error)}), so a later tick projects it`;
    }
    if (typeof now === "string")
      return `its drive ledger did not read again before the write (${now}), so a later tick projects it`;
    return ledgerMark(now) === readMark(drive)
      ? null
      : "its drive ledger changed since this tick read it, so a later tick projects it";
  };
}
