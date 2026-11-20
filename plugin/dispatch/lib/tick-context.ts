/**
 * What every phase of one tick shares: the options it was run with, the
 * session runtime, the tick's clock, this machine's launch records and, with
 * `--apply`, the apply state the launches change as they go. The observe
 * phase reads the launch records as the tick started; the act phase reads
 * them again under the act lock, and builds the apply state from that read.
 */
import type { ApplyState } from "./actions/drive.ts";
import { readHostDrivers } from "./host-drivers.ts";
import { readAccountWeights } from "./local-weights.ts";
import type { ActedRepository, AfterAct } from "./conflict-rates-refresh.ts";
import { enforcedDeadlineMs } from "./actions/launch.ts";
import { actionBook, type ActionBook } from "./failures.ts";
import { failureSettings } from "./machine-config.ts";
import { stateRoot } from "../receipts.ts";
import type { PendingRepository } from "./apply-order.ts";
import type { ReadRecord } from "./launches.ts";
import type { RepoLineInput } from "./line.ts";
import type { MachineConfig } from "./machine-config.ts";
import type { RepoReflection } from "./reflection-route.ts";
import type { RepoObservation } from "./tick-observe.ts";
import type { SessionRuntime } from "./runtime/port.ts";
import { currentMs } from "../../shared/time.ts";
import { boundAt, type TickBound } from "./sources/bounded.ts";
import type { PreparedPriorities } from "./tick-priorities.ts";
import type { TickReads } from "./tick-reads.ts";
import type { RepoReport } from "./types.ts";
import type { WorldView } from "./world-view.ts";

export interface TickOptions {
  repos: string[];
  /** Overrides the follow-up window's start for every repository. */
  followupSince?: string;
  /** Launch what the machine file enables; needs `machine`. */
  apply?: boolean;
  machine?: MachineConfig | null;
  now?: Temporal.Instant;
  runtime?: SessionRuntime;
  /** How many reads the observe phase keeps in flight (`pool.ts`). */
  poolSize?: number;
  /** How long the act phase waits for another tick's act lock before it gives up, in milliseconds. */
  actLockWaitMs?: number;
  /**
   * How long the observe phase waits for a repository's observe lock
   * another tick holds before leaving the repository to it, in
   * milliseconds, within the tick's deadline; none when absent.
   */
  observeLockWaitMs?: number;
  /**
   * What the observe phase reads the forge and the tracker through
   * (`world-view.ts`), made once for the tick from its direct view: a caller
   * wraps the direct view, serves from it where it holds nothing, or
   * replaces it. The direct view when absent. Given by a caller in the same
   * process, never from the command line or a file.
   */
  world?: (direct: WorldView) => WorldView;
  /**
   * What runs once the act phase is done and its locks are given up, with
   * the repositories the tick acted on: the daily refresh of their conflict
   * rates (`conflict-rates-refresh.ts`) when absent. Given by a caller in the
   * same process, never from the command line or a file.
   */
  afterAct?: (
    repos: readonly ActedRepository[],
    tick: AfterAct,
  ) => Promise<unknown>;
}

/** What one repository's turn needs beyond its path. */
export interface TickContext {
  options: TickOptions;
  runtime: SessionRuntime;
  nowMs: number;
  /** When this invocation began, on the clock the launcher's deadline runs on; the apply state counts its deadline from here. */
  startedMs: number;
  /** The tick's one bound, made the first time it is asked for (`tickBound`); absent for a tick no launcher bounds. */
  bound?: TickBound;
  /** What a tick with no deadline of its own lets every repository's release re-runs spend together (`rerunBound`). */
  rerunLimit?: TickBound;
  launches: ReadRecord[];
  weights?: import("./local-weights.ts").AccountWeights | undefined;
  /** The host's live drivers, read once as the tick starts (`host-drivers.ts`). */
  drivers?: import("./host-drivers.ts").HostDrivers | undefined;
  apply: ApplyState | null;
  /** What each repository's tick read beside its report, by path, for the line. */
  lineInputs: Map<string, RepoLineInput>;
  /** Each repository's reflection settings, for the route at the tick's end. */
  reflections: RepoReflection[];
  /** The repositories whose launches wait for every repository to be gathered, to be applied in turns. */
  pending: PendingRepository[];
  /** Each owned repository's priorities inputs, ranked together once every repository is planned (`tick-priorities.ts`). */
  priorities?: PreparedPriorities[];
  /** Each planned repository's observation, weighed for overlap once the priorities ranking has fixed the pickup order. */
  overlaps?: { observation: RepoObservation }[];
  /** The act lock was held when the tick first asked: what serialization read may predate that tick's launches. */
  actWaited?: boolean;
  /** What the tick reads once and shares between its repositories' observe phases. */
  reads: TickReads;
  /** What the observe phase reads the forge and the tracker through (`world-view.ts`); the direct view over `reads` when absent. */
  world?: WorldView;
  /** Why runs again of the follow-ups the host failed are held this tick (`rerun-gate.ts`); `null` or absent while the host's health check passes. */
  rerunsHeld?: string | null;
  /** Each repository's failure ledger book, by `owner/name`, opened by its first action. */
  books?: Map<string, ActionBook>;
  /** The failure ledger's rows for the repositories and the tick were written: a defect after it counts nothing twice. */
  failuresSettled?: boolean;
  /** The exit status the tick's failure row was last settled for. */
  tickSettledExit?: number;
}

/** The launcher's deadline for a tick `machine` bounds that began at `startedMs` (epoch milliseconds), leaving time for the tick to write its receipt; none without a machine file. */
export function deadlineOf(
  machine: MachineConfig | null | undefined,
  startedMs: number,
): number | undefined {
  if (machine == null) return undefined;
  return startedMs + enforcedDeadlineMs(machine) - machine.runtimeTimeoutMs;
}

/**
 * The tick's bound: its deadline (`deadlineOf`) and the signal that fires
 * there, made once and shared by every phase that reads; none for a tick no
 * launcher bounds.
 */
export function tickBound(context: TickContext): TickBound | undefined {
  if (context.bound !== undefined) return context.bound;
  const bound = boundAt(deadlineOf(context.options.machine, context.startedMs));
  if (bound !== undefined) context.bound = bound;
  return bound;
}

/** The bound release re-runs share across the tick's repositories: its deadline, else one limit made on first use. */
export function rerunBound(context: TickContext): TickBound | undefined {
  const bound = tickBound(context);
  if (bound !== undefined) return bound;
  const limit = context.rerunLimit ?? boundAt(currentMs() + 120_000);
  if (limit !== undefined) context.rerunLimit = limit;
  return limit;
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

/** The host's weights and live drivers, as the account views take them. */
export function hostInputs(context: TickContext): {
  weights: TickContext["weights"];
  drivers: TickContext["drivers"];
} {
  return { weights: context.weights, drivers: context.drivers };
}

/** The host's weights and live drivers, read now. */
export function readHostInputs(options: TickOptions): {
  weights: TickContext["weights"];
  drivers: TickContext["drivers"];
} {
  return {
    weights: readAccountWeights(options.machine?.accounts ?? []),
    drivers: readHostDrivers(),
  };
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
