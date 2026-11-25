/**
 * The worker thread of `jig hub serve`: it opens its own connection to the
 * hub's database and runs each run of a job the serve process asks for, as
 * one unit (`runUnit`) with its deadline, so a long run never blocks the
 * listeners on the main thread
 * ([design/control-plane.md § Concurrency and failures](../../../design/control-plane.md#concurrency-and-failures)).
 */
import { parentPort, workerData } from "node:worker_threads";
import { systemClock } from "../../shared/clock.ts";
import { Defect, failed } from "../../shared/outcome.ts";
import type { HubPorts } from "../core/ports.ts";
import { runUnit } from "../core/unit.ts";
import { createStorage } from "../storage/storage.ts";
import type { JobModule } from "./jobs.ts";
import { processObservability } from "./observability.ts";
import { openHubSqlite } from "./sqlite.ts";
import type {
  RunMessage,
  WorkerData,
  WorkerMessage,
} from "./worker-protocol.ts";

/** How long one run of a job may take, beyond the job's own deadline. */
export const JOB_UNIT_MS = 60 * 60 * 1000;

const port = parentPort;
if (port === null)
  throw new Defect("the hub's worker runs only as a worker thread");
const post = (message: WorkerMessage) => port.postMessage(message);
const data = workerData as WorkerData;
const opened = openHubSqlite(data.database);
if (!opened.ok) post({ kind: "unavailable", reason: opened.failure.reason });
else {
  const sqlite = opened.value;
  const unsupported = (what: string) =>
    failed("unavailable", `a job's run cannot ${what} from the worker`);
  const ports: HubPorts = {
    storage: createStorage(sqlite.db, sqlite),
    clock: systemClock,
    observability: processObservability(),
    serving: { serve: async () => unsupported("serve") },
    scheduling: {
      schedule: async () => unsupported("schedule a job"),
      runSoon: async () => unsupported("schedule a job"),
      cancel: async () => unsupported("schedule a job"),
    },
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
  const module = (await import(data.jobs)) as JobModule;
  const handlers = module.jobHandlers(ports);
  port.on("message", async (message: RunMessage) => {
    const handler = handlers.get(message.job);
    const ran =
      handler === undefined
        ? failed("unknown-job", `no handler runs ${message.job}`)
        : await runUnit(
            ports,
            { name: `job:${message.job}`, timeoutMs: JOB_UNIT_MS },
            (context) =>
              handler(context, { job: message.job, dueAt: message.dueAt }),
          );
    post(
      ran.ok
        ? { kind: "done", id: message.id, ok: true }
        : {
            kind: "done",
            id: message.id,
            ok: false,
            code: ran.failure.code,
            reason: ran.failure.reason,
          },
    );
  });
  post({ kind: "ready" });
}
