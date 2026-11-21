/**
 * One racer of the storage contract's race: run in a worker thread with a
 * connection of its own to the store, it waits at a shared barrier before
 * each round, then takes that round's job lease and in-flight read at the
 * same moment as the other racers, and reports whether it won each. An
 * adapter's worker entry opens its store and hands it to `race`.
 */
import { parentPort, workerData } from "node:worker_threads";
import { takeInFlightRead, takeJobLease } from "../../core/operations.ts";
import {
  DIRECTORY_PARTITION,
  repositoryPartition,
} from "../../core/partitions.ts";
import type { StoragePort } from "../../core/storage.ts";

/** What the contract gives every racer beside its adapter's own data. */
interface RacerData {
  /** One 32-bit counter: the round the racers may start. */
  readonly barrier: SharedArrayBuffer;
  readonly rounds: number;
  readonly index: number;
  /** How long a racer waits at the barrier before it gives up, in milliseconds. */
  readonly waitMs: number;
}

/** One racer's answer for one round: whether it took each row, or the failure's code. */
export interface RaceAnswer {
  readonly round: number;
  readonly index: number;
  readonly lease: boolean | string;
  readonly read: boolean | string;
}

/** The time every racer passes, so the rows' conditions are the same for each. */
const RACE_AT = 1_800_000_000_000;
/** The partition the in-flight reads are raced in. */
const RACE_PARTITION = repositoryPartition("acme/race");

/** Waits until the barrier lets `round` start, polling with a deadline. */
function waitFor(barrier: Int32Array, round: number, waitMs: number): void {
  const deadline = performance.now() + waitMs;
  for (;;) {
    const seen = Atomics.load(barrier, 0);
    if (seen >= round) return;
    if (performance.now() > deadline)
      throw new Error(`round ${round} did not start within ${waitMs} ms`);
    Atomics.wait(barrier, 0, seen, 50);
  }
}

/** Runs every round against `storage`, reporting each to the contract. */
export async function race(storage: StoragePort): Promise<void> {
  const data = workerData as RacerData;
  const port = parentPort;
  if (port === null) throw new Error("a racer runs in a worker thread");
  const barrier = new Int32Array(data.barrier);
  const context = {
    unit: `test:racer-${data.index}`,
    signal: new AbortController().signal,
    deadlineAt: RACE_AT + 60_000,
  };
  const holder = `racer-${data.index}`;
  port.postMessage({ ready: data.index });
  for (let round = 1; round <= data.rounds; round++) {
    waitFor(barrier, round, data.waitMs);
    const lease = await storage.run(
      context,
      DIRECTORY_PARTITION,
      takeJobLease,
      {
        job: `race-${round}`,
        holder,
        now: RACE_AT,
        leaseMs: 60_000,
      },
    );
    const read = await storage.run(context, RACE_PARTITION, takeInFlightRead, {
      target: `race-${round}`,
      holder,
      now: RACE_AT,
    });
    const answer: RaceAnswer = {
      round,
      index: data.index,
      lease: lease.ok ? lease.value.taken : lease.failure.code,
      read: read.ok ? read.value.taken : read.failure.code,
    };
    port.postMessage(answer);
  }
}
