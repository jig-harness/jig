/**
 * What a component of the `jig` command gives the lifecycle verbs
 * (`jig install`, `uninstall`, `upgrade`, `doctor`, `status`, `receipts` and
 * `run`, in `verbs.ts`): its name, its own command, the job its timer runs,
 * how it is installed, removed, reported on and checked, and how its
 * receipts are read. Resource
 * collection (`gc/component.ts`) and the dispatcher (`dispatch/component.ts`)
 * implement it and `jig.ts` registers them. The verbs reach a component only
 * through this interface, so a third one joins by implementing it and being
 * registered, with no change to the verbs.
 */
import type { Parser } from "../shared/vendor/optique.mjs";
import type { InstalledJob } from "./installed-job.ts";
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
  /** Why the run failed, for a person; absent when it passed or its receipt does not say. */
  reason?: string;
  /**
   * The failed runs in a row that this one ends: how many, and when the
   * first of them started; `capped` when the read stopped at its limit, so
   * there were at least that many. Absent when the run passed.
   */
  failing?: { runs: number; since: string; capped: boolean };
  /**
   * Set when the read spent its limit on receipts that are no evidence of a
   * run, so the last run is unknown rather than absent: the count read. The
   * run's own fields are then empty.
   */
  unread?: number;
}

/** One component's entry in `jig status`. */
export interface ComponentStatus {
  component: string;
  /** Whether the scheduler holds the component's job. */
  installed: boolean;
  /** Where the job is, or why there is none. */
  detail: string;
  /** Set when the scheduler could not be read: whether the job exists is then unknown. */
  error?: string;
  /** The installed job's schedule in words (`daily at 04:00`, `every 5 minutes`). */
  schedule: string | null;
  /** When the installed job runs next (an ISO time), where the schedule alone tells. */
  nextRun: string | null;
  lastRun: LastRun | null;
}

/** One check `jig doctor` reports. */
export interface DoctorCheck {
  /** Its stable name: `<component>:<what>` for a component's (`dispatch:orca`). */
  id: string;
  /** `skip` where the check does not apply on this machine. */
  status: "pass" | "fail" | "skip";
  detail: string;
  /** For a failure: the command that fixes it, or what to do. */
  fix?: string;
}

/** What `jig doctor` read before it asks a component for its own checks. */
export interface DoctorContext {
  /** The component's installed job, read back from the scheduler; null when there is none. */
  job: InstalledJob | null;
}

/**
 * A command of `jig` that runs and exits, with no job for a timer and
 * nothing to install (`jig ask`): `jig.ts` registers it beside the
 * components, and the lifecycle verbs never act on it.
 */
export interface CommandComponent<A = unknown> {
  /** Its command's name (`jig ask`). */
  readonly name: string;
  /** Its own command, `jig <name> …`, as an Optique parser. */
  readonly command: Parser<"sync", A, unknown>;
  /** Runs what its own command parsed. */
  main(args: A, script: string): Promise<number>;
}

export interface Component<A = unknown> extends CommandComponent<A> {
  /** Its command's name (`jig gc`) and its name to the verbs (`jig install gc`). */
  readonly name: string;
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
   * The jobs its install writes beside `job()`, each on a timer of its own
   * (the dispatcher's change probe): `jig upgrade` refreshes each one the
   * scheduler holds as it does `job()`, and its own install and uninstall
   * write and remove them.
   */
  companionJobs?(): JobSpec[];
  /**
   * Null when `jig install` and `jig run` with no component named include it;
   * otherwise why they leave it out, with what to do about it.
   */
  missingOptIn(): string | null;
  install(request: InstallRequest): Promise<number>;
  uninstall(request: UninstallRequest): Promise<number>;
  status(): Promise<ComponentStatus>;
  /**
   * Its own checks for `jig doctor` (its machine file, the programs its work
   * needs), beside the ones every component gets: its launcher copy, the
   * programs its job names and its last run.
   */
  doctor?(context: DoctorContext): Promise<DoctorCheck[]>;
  /** Prints its receipts, that day's (`YYYY-MM-DD`), or the run with that id. */
  receipts(query: string | undefined): number;
}
