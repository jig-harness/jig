/**
 * `jig hub serve`'s process: the portable core on Bun, with its database
 * through `bun:sqlite`, its three listeners, its timers and its worker
 * thread ([design/control-plane.md § Where it lives](../../../design/control-plane.md#where-it-lives)).
 *
 * It refuses to start when the settings file or the database directory is
 * readable by another user, opens the database in that directory, starts
 * the scheduled jobs' timers and the worker that runs them, binds the
 * listeners and records what each bound in `serve.json` in the database
 * directory, which `jig doctor hub` reads. It stops when its signal
 * aborts, and removes that record.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemClock } from "../../shared/clock.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import { currentIso } from "../../shared/time.ts";
import type { HubPorts } from "../core/ports.ts";
import type { SchedulingPort } from "../core/scheduling.ts";
import {
  emptyRoutes,
  type HubRoutes,
  listenerHandlers,
} from "../core/routes.ts";
import { TRIM_JOB, scheduleTrimming } from "../core/trimming.ts";
import { runUnit, type UnitContext } from "../core/unit.ts";
import { createStorage } from "../storage/storage.ts";
import { JOB_NAMES } from "./jobs.ts";
import type { BoundListener } from "./listeners.ts";
import { processObservability } from "./observability.ts";
import { HUB_JOBS, workerRunner } from "./runner.ts";
import { processScheduling } from "./scheduling.ts";
import { processServing } from "./serving.ts";
import {
  checkPrivate,
  type HubSettings,
  type Identity,
  type StatReader,
} from "./settings.ts";
import { openHubSqlite } from "./sqlite.ts";

/** The database file in the database directory. */
const DATABASE_FILE = "hub.sqlite";
/** What a running hub bound, in the database directory. */
const SERVE_RECORD = "serve.json";

/** What `serve.json` holds. */
export interface ServeRecord {
  readonly pid: number;
  readonly startedAt: string;
  readonly listeners: readonly { name: string; address: string }[];
}

export interface HubOptions {
  readonly settings: HubSettings;
  readonly identity: Pick<Identity, "uid">;
  /** Aborts to stop the hub. */
  readonly stop: AbortSignal;
  /** The listeners' route tables; empty when absent. */
  readonly routes?: HubRoutes;
  /** The module of jobs the worker runs, and their names; the hub's own when absent. */
  readonly jobs?: {
    readonly module: string;
    readonly names: readonly string[];
  };
  readonly stat?: StatReader;
}

export interface RunningHub {
  readonly listeners: readonly BoundListener[];
  /** The hub's scheduling, for a caller that runs a job soon. */
  readonly scheduling: SchedulingPort;
  /** Settles once the hub has stopped. */
  readonly stopped: Promise<void>;
}

export type HubStartFailure = "unavailable" | "unreadable" | "exposed";

function isServeRecord(value: unknown): value is ServeRecord {
  if (typeof value !== "object" || value === null) return false;
  const listeners = (value as { listeners?: unknown }).listeners;
  return (
    Array.isArray(listeners) &&
    listeners.every(
      (listener: unknown) =>
        typeof listener === "object" &&
        listener !== null &&
        typeof (listener as { name?: unknown }).name === "string" &&
        typeof (listener as { address?: unknown }).address === "string",
    )
  );
}

/** Reads what the running hub recorded; null when there is no record. */
export function readServeRecord(database: string): ServeRecord | null {
  const text = attempt("absent", "", () =>
    readFileSync(join(database, SERVE_RECORD), "utf8"),
  );
  if (!text.ok) return null;
  const parsed = attempt("invalid", "", (): unknown => JSON.parse(text.value));
  return parsed.ok && isServeRecord(parsed.value) ? parsed.value : null;
}

function unavailablePorts(): Pick<HubPorts, "outbound"> {
  return {
    outbound: {
      call: async () => ({
        ok: false,
        failure: {
          code: "unreachable",
          reason: "the hub has no outbound transport yet",
        },
      }),
    },
  };
}

/** Starts the hub; it runs until `options.stop` aborts. */
export async function startHub(
  options: HubOptions,
): Promise<Outcome<RunningHub, HubStartFailure>> {
  const { settings } = options;
  const made = attempt(
    "unavailable",
    `cannot make the database directory ${settings.database}`,
    () => mkdirSync(settings.database, { recursive: true, mode: 0o700 }),
  );
  if (!made.ok) return made;
  const kept = checkPrivate(settings, options.identity, options.stat);
  if (!kept.ok) return kept;
  const file = join(settings.database, DATABASE_FILE);
  const opened = openHubSqlite(file);
  if (!opened.ok) return opened;
  const sqlite = opened.value;
  const jobs = options.jobs ?? { module: HUB_JOBS, names: JOB_NAMES };
  const runner = workerRunner(file, jobs.module);
  const base = {
    storage: createStorage(sqlite.db, sqlite),
    clock: systemClock,
    observability: processObservability(),
  };
  const scheduling = processScheduling({
    ports: base,
    runner,
    knownJobs: jobs.names,
  });
  let markBound: (listeners: readonly BoundListener[]) => void = () => {
    // Replaced below, before `serve` can call it.
  };
  const bound = new Promise<readonly BoundListener[]>((resolve) => {
    markBound = resolve;
  });
  const ports: HubPorts = {
    ...base,
    ...unavailablePorts(),
    scheduling,
    serving: processServing(settings, base, (listeners) =>
      markBound(listeners),
    ),
  };
  const shutdown = async () => {
    scheduling.stop();
    await runner.stop();
    sqlite.close();
    rmSync(join(settings.database, SERVE_RECORD), { force: true });
  };
  const started = await runUnit(
    ports,
    { name: "hub:start", timeoutMs: 30_000 },
    async (context) => {
      const armed = await scheduling.start(context);
      if (!armed.ok) return armed;
      return jobs.names.includes(TRIM_JOB)
        ? scheduleTrimming(ports, context)
        : ok(undefined);
    },
  );
  if (!started.ok) {
    await shutdown();
    return failed("unavailable", started.failure.reason);
  }
  const serving: UnitContext = {
    unit: "hub:serve",
    signal: options.stop,
    deadlineAt: Number.MAX_SAFE_INTEGER,
  };
  const served = ports.serving.serve(
    serving,
    listenerHandlers(options.routes ?? emptyRoutes()),
  );
  // `serve` settles before every listener is up only when one could not bind.
  const up = await Promise.race([
    served.then((outcome) => outcome),
    bound.then((listeners) => ok(listeners)),
  ]);
  if (!up.ok || up.value === undefined) {
    await shutdown();
    return failed(
      "unavailable",
      up.ok ? "the hub stopped before it listened" : up.failure.reason,
    );
  }
  const listeners = up.value;
  const record: ServeRecord = {
    pid: process.pid,
    startedAt: currentIso(),
    listeners: listeners.map(({ name, address }) => ({ name, address })),
  };
  writeFileSync(
    join(settings.database, SERVE_RECORD),
    JSON.stringify(record, null, 2),
    {
      mode: 0o600,
    },
  );
  return ok({
    listeners,
    scheduling,
    stopped: served.then(shutdown),
  });
}
