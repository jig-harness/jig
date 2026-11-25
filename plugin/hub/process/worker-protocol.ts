/**
 * The messages between the serve process and its worker thread: the
 * process asks for one run of a job, the worker answers when it ends.
 */

/** What the worker is started with. */
export interface WorkerData {
  /** The database file the worker opens its own connection to. */
  readonly database: string;
  /** The module of jobs it runs (`jobs.ts`, or a test's), as a URL. */
  readonly jobs: string;
}

/** The process asks for one run. */
export interface RunMessage {
  readonly kind: "run";
  readonly id: number;
  readonly job: string;
  readonly dueAt: number;
}

/** The worker says it is ready, could not start, or how a run ended. */
export type WorkerMessage =
  | { readonly kind: "ready" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "done"; readonly id: number; readonly ok: true }
  | {
      readonly kind: "done";
      readonly id: number;
      readonly ok: false;
      readonly code: string;
      readonly reason: string;
    };
