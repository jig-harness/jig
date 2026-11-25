/**
 * The serve process's side of its worker thread: hands one run of a job to
 * the worker and waits for its answer. A worker that fails or exits fails
 * every run it held as `unavailable`, and the next run starts a new one.
 */
import { Worker } from "node:worker_threads";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import type { RunMessage, WorkerMessage } from "./worker-protocol.ts";

/** Runs jobs away from the listeners' thread. */
export interface JobRunner {
  run(job: string, dueAt: number): Promise<Outcome<void>>;
  /** Ends the worker; a run still held fails `unavailable`. */
  stop(): Promise<void>;
}

/** The hub's own jobs module, as the worker imports it. */
export const HUB_JOBS = new URL("./jobs.ts", import.meta.url).href;
const WORKER = new URL("./worker.ts", import.meta.url);

type Settle = (outcome: Outcome<void>) => void;

/** A runner over a worker thread with its own connection to `database`. */
export function workerRunner(database: string, jobs = HUB_JOBS): JobRunner {
  let worker: Worker | null = null;
  let ready: Promise<Outcome<Worker, "unavailable">> | null = null;
  let next = 0;
  const pending = new Map<number, Settle>();
  const failAll = (reason: string) => {
    for (const settle of pending.values())
      settle(failed("unavailable", reason));
    pending.clear();
    worker = null;
    ready = null;
  };
  const start = (): Promise<Outcome<Worker, "unavailable">> =>
    new Promise((resolve) => {
      const started = new Worker(WORKER, { workerData: { database, jobs } });
      started.on("message", (message: WorkerMessage) => {
        if (message.kind === "ready") resolve(ok(started));
        else if (message.kind === "unavailable") {
          resolve(failed("unavailable", message.reason));
          void started.terminate();
        } else {
          const settle = pending.get(message.id);
          pending.delete(message.id);
          settle?.(
            message.ok ? ok(undefined) : failed(message.code, message.reason),
          );
        }
      });
      started.on("error", (error: unknown) => {
        const reason = `the worker failed: ${error instanceof Error ? error.message : String(error)}`;
        resolve(failed("unavailable", reason));
        failAll(reason);
      });
      started.on("exit", (code) => {
        resolve(failed("unavailable", `the worker exited with ${code}`));
        failAll(`the worker exited with ${code}`);
      });
      worker = started;
    });
  return {
    run: async (job, dueAt) => {
      ready ??= start();
      const started = await ready;
      if (!started.ok) {
        ready = null;
        return started;
      }
      const id = ++next;
      return new Promise<Outcome<void>>((settle) => {
        pending.set(id, settle);
        const message: RunMessage = { kind: "run", id, job, dueAt };
        started.value.postMessage(message);
      });
    },
    stop: async () => {
      const running = worker;
      failAll("the hub is stopping");
      if (running !== null) await running.terminate();
    },
  };
}
