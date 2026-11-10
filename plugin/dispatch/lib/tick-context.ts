/**
 * What every phase of one tick shares: the options it was run with, the
 * session runtime, the tick's clock, this machine's launch records and, with
 * `--apply`, the apply state the launches change as they go. The observe
 * phase reads the launch records as the tick started; the act phase reads
 * them again under the act lock, and builds the apply state from that read.
 */
import type { ApplyState } from "./actions/drive.ts";
import { actionBook, type ActionBook } from "./failures.ts";
import { failureSettings } from "./machine-config.ts";
import { stateRoot } from "../receipts.ts";
import type { PendingRepository } from "./apply-order.ts";
import type { ReadRecord } from "./launches.ts";
import type { RepoLineInput } from "./line.ts";
import type { MachineConfig } from "./machine-config.ts";
import type { RepoReflection } from "./reflection-route.ts";
import type { SessionRuntime } from "./runtime/port.ts";
import type { TickReads } from "./tick-reads.ts";
import type { RepoReport } from "./types.ts";

export interface TickOptions {
  repos: string[];
  /** Overrides the follow-up window's start for every repository. */
  followupSince?: string;
  /** Launch what the machine file enables; needs `machine`. */
  apply?: boolean;
  machine?: MachineConfig | null;
  now?: Date;
  runtime?: SessionRuntime;
  /** How many reads the observe phase keeps in flight (`pool.ts`). */
  poolSize?: number;
  /** How long the act phase waits for another tick's act lock before it gives up, in milliseconds. */
  actLockWaitMs?: number;
}

/** What one repository's turn needs beyond its path. */
export interface TickContext {
  options: TickOptions;
  runtime: SessionRuntime;
  nowMs: number;
  /** When this invocation began, on the clock the launcher's deadline runs on; the apply state counts its deadline from here. */
  startedMs: number;
  launches: ReadRecord[];
  apply: ApplyState | null;
  /** What each repository's tick read beside its report, by path, for the line. */
  lineInputs: Map<string, RepoLineInput>;
  /** Each repository's reflection settings, for the route at the tick's end. */
  reflections: RepoReflection[];
  /** The repositories whose launches wait for every repository to be gathered, to be applied in turns. */
  pending: PendingRepository[];
  /** The act lock was held when the tick first asked: what serialization read may predate that tick's launches. */
  actWaited?: boolean;
  /** What the tick reads once and shares between its repositories' observe phases. */
  reads: TickReads;
  /** Each repository's failure ledger book, by `owner/name`, opened by its first action. */
  books?: Map<string, ActionBook>;
  /** The failure ledger's rows for the repositories and the tick were written: a defect after it counts nothing twice. */
  failuresSettled?: boolean;
  /** The exit status the tick's failure row was last settled for. */
  tickSettledExit?: number;
}

/**
 * The failure ledger's book of a repository's actions (`failures.ts`), with
 * `--apply` only; a write the ledger cannot make is reported as unplaced and
 * stops nothing.
 */
export function bookOf(
  context: TickContext,
  slug: string,
  report: RepoReport,
): ActionBook | null {
  const apply = context.apply;
  if (apply === null) return null;
  context.books ??= new Map();
  const known = context.books.get(slug);
  if (known !== undefined) return known;
  const book = actionBook(
    slug,
    failureSettings(apply.machine),
    (reason) =>
      report.unplaced.push({
        target: "the failure ledger",
        record: "runtime",
        reason,
      }),
    apply.root ?? stateRoot(),
  );
  context.books.set(slug, book);
  return book;
}

/** This machine's launch records, the ones this tick writes included. */
export function allRecords(context: TickContext): ReadRecord[] {
  return context.apply?.records ?? context.launches;
}

export function emptyReport(path: string, refused: string): RepoReport {
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
    notifications: [],
    quiet: [],
  };
}
