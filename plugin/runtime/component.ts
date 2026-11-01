/**
 * What a component of the `jig` command gives the lifecycle verbs
 * (`jig install`, `uninstall`, `status`, `receipts` and `run`, in
 * `verbs.ts`): its name, its own command, the job its timer runs, and how it
 * is installed, removed, reported on and its receipts read. Resource
 * collection (`gc/component.ts`) and the dispatcher (`dispatch/component.ts`)
 * implement it and `jig.ts` registers them. The verbs reach a component only
 * through this interface, so a third one joins by implementing it and being
 * registered, with no change to the verbs.
 */
import type { Parser } from "../shared/vendor/optique.mjs";
import type { JobSpec } from "./job-spec.ts";

/** What `jig install` passes each component it installs. */
export interface InstallRequest {
  /** `--repo`, resolved against the working directory; absent, the current checkout. */
  repository: string | undefined;
  /** `--yes`: write what the preview shows. Without it, only the preview. */
  confirm: boolean;
  /** The running `jig.ts`. Writing a job requires the installed plugin copy. */
  script: string;
}

/** What `jig uninstall` passes each component it removes. */
export interface UninstallRequest extends InstallRequest {
  /**
   * `--machine`: remove the component's machine-wide part (its job), not only
   * what it holds for the repository.
   */
  machine: boolean;
}

/** The latest run a component's receipts record. */
export interface LastRun {
  runId: string;
  startedAt: string;
  completed: boolean;
  exitStatus: number;
  /** The receipt's file. */
  path: string;
}

/** One component's entry in `jig status`. */
export interface ComponentStatus {
  component: string;
  /** Whether the scheduler holds the component's job. */
  installed: boolean;
  /** Where the job is, or why there is none. */
  detail: string;
  /** The installed job's schedule in words (`daily at 04:00`, `every 5 minutes`). */
  schedule: string | null;
  /** When the installed job runs next (an ISO time), where the schedule alone tells. */
  nextRun: string | null;
  lastRun: LastRun | null;
}

export interface Component<A = unknown> {
  /** Its command's name (`jig gc`) and its name to the verbs (`jig install gc`). */
  readonly name: string;
  /** Its own command, `jig <name> …`, as an Optique parser. */
  readonly command: Parser<"sync", A, unknown>;
  /** Runs what its own command parsed. */
  main(args: A, script: string): Promise<number>;
  /**
   * A stricter parser for the same command, for a check that only the winning
   * value of a repeated option has to meet; with `strictArguments`.
   */
  readonly strictCommand?: Parser<"sync", A, unknown>;
  /**
   * The command line to parse again with `strictCommand`, or null when the
   * parsed `args` need no second parse.
   */
  strictArguments?(args: A, argv: readonly string[]): readonly string[] | null;
  /** The job its timer runs: `jig run` runs `job().args`, and `status` looks the job up by its names. */
  job(): JobSpec;
  /**
   * Null when `jig install` and `jig run` with no component named include it;
   * otherwise why they leave it out, with what to do about it.
   */
  missingOptIn(): string | null;
  install(request: InstallRequest): Promise<number>;
  uninstall(request: UninstallRequest): Promise<number>;
  status(): Promise<ComponentStatus>;
  /** Prints its receipts, that day's (`YYYY-MM-DD`), or the run with that id. */
  receipts(query: string | undefined): number;
}
