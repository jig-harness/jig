/**
 * What every phase of one tick shares: the options it was run with, the
 * session runtime, the tick's clock, this machine's launch records and, with
 * `--apply`, the apply state the launches change as they go.
 */
import type { ApplyState } from "./actions/drive.ts";
import type { ReadRecord } from "./launches.ts";
import type { RepoLineInput } from "./line.ts";
import type { MachineConfig } from "./machine-config.ts";
import type { SessionRuntime } from "./runtime/port.ts";
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
}

/** What one repository's turn needs beyond its path. */
export interface TickContext {
  options: TickOptions;
  runtime: SessionRuntime;
  nowMs: number;
  launches: ReadRecord[];
  apply: ApplyState | null;
  /** What each repository's tick read beside its report, by path, for the line. */
  lineInputs: Map<string, RepoLineInput>;
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
