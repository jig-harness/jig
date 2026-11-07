/**
 * What every phase of one tick shares: the options it was run with, the
 * session runtime, the tick's clock, this machine's launch records and, with
 * `--apply`, the apply state the launches change as they go. The observe
 * phase reads the launch records as the tick started; the act phase reads
 * them again under the act lock, and builds the apply state from that read.
 */
import type { ApplyState } from "./actions/drive.ts";
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
  /** What the tick reads once and shares between its repositories' observe phases. */
  reads: TickReads;
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
