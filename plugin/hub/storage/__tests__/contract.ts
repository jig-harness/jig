/**
 * The storage contract: what every adapter's storage must do, as tests any
 * adapter registers with its own harness (`bun-sqlite.test.ts` runs it on
 * `bun:sqlite`). It holds every named operation to its behaviour, the
 * atomic batch to all-or-nothing, the in-flight read row and the job lease
 * rows to their conditions, the trimming to its partition and its limit,
 * and every operation's query plan to an index: every statement a sample
 * input prepares reads through an index or a primary key, and the suite
 * fails an operation that has no sample.
 */
import { afterEach, describe, expect, test } from "bun:test";
import * as operations from "../../core/operations.ts";
import {
  finishJob,
  IN_FLIGHT_READ_MS,
  readInFlightRead,
  readJob,
  releaseInFlightRead,
  saveJobProgress,
  takeInFlightRead,
  takeJobLease,
  trimExpired,
} from "../../core/operations.ts";
import {
  DIRECTORY_PARTITION,
  hostPartition,
  repositoryPartition,
} from "../../core/partitions.ts";
import {
  type StorageOperation,
  type StoragePort,
  step,
} from "../../core/storage.ts";
import type { UnitContext } from "../../core/unit.ts";
import type { StorageInspection } from "../storage.ts";

/** One opened store: its storage, and a second connection to the same store. */
export interface StorageHarness {
  readonly storage: StoragePort & { readonly inspection: StorageInspection };
  /** Another connection to the same store, as a second process or worker opens. */
  connect(): StoragePort;
  close(): void;
}

const P = repositoryPartition("acme/widgets");
const OTHER = repositoryPartition("acme/gears");
const T0 = 1_800_000_000_000;

/** A unit's context that never aborts on its own. */
function context(): UnitContext {
  return {
    unit: "test:storage",
    signal: new AbortController().signal,
    deadlineAt: T0 + 60_000,
  };
}

/** A sample input for an operation, in a partition, for its query plan. */
interface Sample {
  readonly partition: string;
  readonly input: unknown;
}

/** At least one sample per operation the storage holds. */
const SAMPLES: Record<string, readonly Sample[]> = {
  takeInFlightRead: [
    { partition: P, input: { target: "pull:12", holder: "a", now: T0 } },
  ],
  releaseInFlightRead: [
    { partition: P, input: { target: "pull:12", holder: "a" } },
  ],
  readInFlightRead: [{ partition: P, input: { target: "pull:12" } }],
  takeJobLease: [
    {
      partition: DIRECTORY_PARTITION,
      input: { job: "sweep", holder: "a", now: T0, leaseMs: 1_000 },
    },
  ],
  saveJobProgress: [
    {
      partition: DIRECTORY_PARTITION,
      input: {
        job: "sweep",
        holder: "a",
        now: T0,
        leaseMs: 1_000,
        progress: { at: 1 },
      },
    },
  ],
  finishJob: [
    {
      partition: DIRECTORY_PARTITION,
      input: { job: "sweep", holder: "a", now: T0 },
    },
  ],
  readJob: [{ partition: DIRECTORY_PARTITION, input: { job: "sweep" } }],
  trimExpired: [
    {
      partition: P,
      input: {
        table: "in_flight_reads",
        column: "deadline_at",
        before: T0,
        limit: 100,
      },
    },
  ],
};

/** Every storage operation `core/operations.ts` declares. */
function declaredOperations(): StorageOperation<unknown, unknown>[] {
  return (Object.values(operations) as unknown[]).filter(
    (value): value is StorageOperation<unknown, unknown> =>
      typeof value === "object" &&
      value !== null &&
      "name" in value &&
      "kind" in value,
  );
}

/** Whether a plan row reads a table through an index or a primary key. */
const INDEXED =
  /^SEARCH \S+ USING (?:COVERING )?(?:INDEX \S+|(?:INTEGER )?PRIMARY KEY) \(/;

/** Registers the storage contract's tests against stores `open` gives. */
export function storageContract(
  adapter: string,
  open: () => StorageHarness,
): void {
  describe(`the storage contract on ${adapter}`, () => {
    let opened: StorageHarness[] = [];
    afterEach(() => {
      for (const harness of opened) harness.close();
      opened = [];
    });
    const store = () => {
      const harness = open();
      opened.push(harness);
      return harness;
    };
    const ok = <T>(
      outcome: { ok: true; value: T } | { ok: false; failure: unknown },
    ): T => {
      if (!outcome.ok)
        throw new Error(`expected a value: ${JSON.stringify(outcome)}`);
      return outcome.value;
    };

    describe("the operations it holds", () => {
      test("every operation the core declares, and a sample of each", () => {
        const { inspection } = store().storage;
        expect([...inspection.operations].sort()).toEqual(
          declaredOperations()
            .map((op) => op.name)
            .sort(),
        );
        expect(Object.keys(SAMPLES).sort()).toEqual(
          [...inspection.operations].sort(),
        );
      });

      test("each operation's query plan reads through an index", () => {
        const { inspection } = store().storage;
        const byName = new Map(declaredOperations().map((op) => [op.name, op]));
        for (const name of inspection.operations) {
          const op = byName.get(name) as StorageOperation<unknown, unknown>;
          for (const sample of SAMPLES[name] ?? []) {
            const plans = ok(
              inspection.explain(sample.partition, op, sample.input),
            );
            const rows = plans.flat().map((row) => row.detail);
            // An insert by its key shows no plan; every other read is a search.
            expect({
              name,
              scans: rows.filter((r) => /^SCAN /.test(r)),
            }).toEqual({ name, scans: [] });
            const searches = rows.filter((r) => /^SEARCH /.test(r));
            expect({ name, searched: searches.length > 0 }).toEqual({
              name,
              searched: true,
            });
            for (const row of searches)
              expect({ name, row, indexed: INDEXED.test(row) }).toEqual({
                name,
                row,
                indexed: true,
              });
          }
        }
      });

      test("a table or column no retention rule trims has no sample to plan", () => {
        const { inspection } = store().storage;
        const refused = inspection.explain(
          P,
          trimExpired as StorageOperation<unknown, unknown>,
          { table: "job_leases", column: "started_at", before: T0, limit: 1 },
        );
        expect(refused.ok ? null : refused.failure.code).toBe("refused");
      });
    });

    describe("what every call refuses", () => {
      test("a partition that does not parse, an operation it does not hold, a stopped unit", async () => {
        const { storage } = store();
        const bad = await storage.run(context(), "acme/widgets", readJob, {
          job: "x",
        });
        expect(bad.ok ? null : bad.failure.code).toBe("refused");
        const unknown = await storage.run(
          context(),
          P,
          { name: "dropEverything", kind: "change" },
          {},
        );
        expect(unknown.ok ? null : unknown.failure.code).toBe("refused");
        const stop = new AbortController();
        stop.abort();
        const stopped = await storage.run(
          { ...context(), signal: stop.signal },
          P,
          readJob,
          { job: "x" },
        );
        expect(stopped.ok ? null : stopped.failure.code).toBe("aborted");
        const batch = await storage.batch(
          { ...context(), signal: stop.signal },
          P,
          [step(releaseInFlightRead, { target: "t", holder: "a" })],
        );
        expect(batch.ok ? null : batch.failure.code).toBe("aborted");
      });

      test("the three kinds of partition each hold their own rows", async () => {
        const { storage } = store();
        const partitions = [P, hostPartition("build-01"), DIRECTORY_PARTITION];
        for (const [index, partition] of partitions.entries())
          ok(
            await storage.run(context(), partition, takeInFlightRead, {
              target: "same",
              holder: `h${index}`,
              now: T0,
            }),
          );
        for (const [index, partition] of partitions.entries())
          expect(
            ok(
              await storage.run(context(), partition, readInFlightRead, {
                target: "same",
              }),
            )?.holder,
          ).toBe(`h${index}`);
      });
    });

    describe("the in-flight read row", () => {
      test("taken once; a second taker learns who holds it and until when", async () => {
        const { storage } = store();
        const first = ok(
          await storage.run(context(), P, takeInFlightRead, {
            target: "pull:12",
            holder: "a",
            now: T0,
          }),
        );
        expect(first).toEqual({ taken: true, until: T0 + IN_FLIGHT_READ_MS });
        const second = ok(
          await storage.run(context(), P, takeInFlightRead, {
            target: "pull:12",
            holder: "b",
            now: T0 + IN_FLIGHT_READ_MS - 1,
          }),
        );
        expect(second).toEqual({
          taken: false,
          holder: "a",
          until: T0 + IN_FLIGHT_READ_MS,
        });
        expect(
          ok(
            await storage.run(context(), P, readInFlightRead, {
              target: "pull:12",
            }),
          ),
        ).toEqual({
          target: "pull:12",
          holder: "a",
          takenAt: T0,
          deadlineAt: T0 + IN_FLIGHT_READ_MS,
        });
      });

      test("taken over once its 30 seconds have passed", async () => {
        const { storage } = store();
        ok(
          await storage.run(context(), P, takeInFlightRead, {
            target: "pull:12",
            holder: "a",
            now: T0,
          }),
        );
        const later = T0 + IN_FLIGHT_READ_MS;
        expect(
          ok(
            await storage.run(context(), P, takeInFlightRead, {
              target: "pull:12",
              holder: "b",
              now: later,
            }),
          ),
        ).toEqual({ taken: true, until: later + IN_FLIGHT_READ_MS });
      });

      test("released only by its holder", async () => {
        const { storage } = store();
        ok(
          await storage.run(context(), P, takeInFlightRead, {
            target: "pull:12",
            holder: "a",
            now: T0,
          }),
        );
        expect(
          ok(
            await storage.run(context(), P, releaseInFlightRead, {
              target: "pull:12",
              holder: "b",
            }),
          ),
        ).toEqual({ released: false });
        expect(
          ok(
            await storage.run(context(), P, releaseInFlightRead, {
              target: "pull:12",
              holder: "a",
            }),
          ),
        ).toEqual({ released: true });
        expect(
          ok(
            await storage.run(context(), P, readInFlightRead, {
              target: "pull:12",
            }),
          ),
        ).toBeNull();
      });

      test("one partition's row leaves another's target free", async () => {
        const { storage } = store();
        for (const partition of [P, OTHER])
          expect(
            ok(
              await storage.run(context(), partition, takeInFlightRead, {
                target: "pull:12",
                holder: partition,
                now: T0,
              }),
            ).taken,
          ).toBe(true);
      });
    });

    describe("the job lease row", () => {
      const lease = { job: "sweep", leaseMs: 1_000 };

      test("taken by one run; another learns who holds it", async () => {
        const { storage } = store();
        expect(
          ok(
            await storage.run(context(), DIRECTORY_PARTITION, takeJobLease, {
              ...lease,
              holder: "a",
              now: T0,
            }),
          ),
        ).toEqual({ taken: true, until: T0 + 1_000, progress: null });
        expect(
          ok(
            await storage.run(context(), DIRECTORY_PARTITION, takeJobLease, {
              ...lease,
              holder: "b",
              now: T0 + 999,
            }),
          ),
        ).toEqual({ taken: false, holder: "a", until: T0 + 1_000 });
      });

      test("progress is saved and the lease renewed only while it is held", async () => {
        const { storage } = store();
        const at = DIRECTORY_PARTITION;
        ok(
          await storage.run(context(), at, takeJobLease, {
            ...lease,
            holder: "a",
            now: T0,
          }),
        );
        const save = (holder: string, now: number, done: number) =>
          storage.run(context(), at, saveJobProgress, {
            ...lease,
            holder,
            now,
            progress: { done },
          });
        expect(ok(await save("b", T0 + 10, 1))).toEqual({ saved: false });
        expect(ok(await save("a", T0 + 500, 1))).toEqual({ saved: true });
        // Renewed to T0 + 1_500, so the lease still holds at T0 + 1_200.
        expect(ok(await save("a", T0 + 1_200, 2))).toEqual({ saved: true });
        expect(ok(await save("a", T0 + 2_200, 3))).toEqual({ saved: false });
        expect(
          ok(await storage.run(context(), at, readJob, { job: "sweep" })),
        ).toEqual({
          job: "sweep",
          holder: "a",
          leaseUntil: T0 + 2_200,
          progress: { done: 2 },
          startedAt: T0,
          finishedAt: null,
          updatedAt: T0 + 1_200,
        });
      });

      test("a lapsed lease is taken over with the progress it left", async () => {
        const { storage } = store();
        const at = DIRECTORY_PARTITION;
        ok(
          await storage.run(context(), at, takeJobLease, {
            ...lease,
            holder: "a",
            now: T0,
          }),
        );
        ok(
          await storage.run(context(), at, saveJobProgress, {
            ...lease,
            holder: "a",
            now: T0,
            progress: { next: 3 },
          }),
        );
        expect(
          ok(
            await storage.run(context(), at, takeJobLease, {
              ...lease,
              holder: "b",
              now: T0 + 1_000,
            }),
          ),
        ).toEqual({ taken: true, until: T0 + 2_000, progress: { next: 3 } });
        expect(
          ok(
            await storage.run(context(), at, saveJobProgress, {
              ...lease,
              holder: "a",
              now: T0 + 1_001,
              progress: { next: 4 },
            }),
          ),
        ).toEqual({ saved: false });
      });

      test("finishing clears the lease and the progress, by its holder only", async () => {
        const { storage } = store();
        const at = DIRECTORY_PARTITION;
        ok(
          await storage.run(context(), at, takeJobLease, {
            ...lease,
            holder: "a",
            now: T0,
          }),
        );
        ok(
          await storage.run(context(), at, saveJobProgress, {
            ...lease,
            holder: "a",
            now: T0,
            progress: { next: 1 },
          }),
        );
        expect(
          ok(
            await storage.run(context(), at, finishJob, {
              job: "sweep",
              holder: "b",
              now: T0 + 5,
            }),
          ),
        ).toEqual({ finished: false });
        expect(
          ok(
            await storage.run(context(), at, finishJob, {
              job: "sweep",
              holder: "a",
              now: T0 + 10,
            }),
          ),
        ).toEqual({ finished: true });
        expect(
          ok(await storage.run(context(), at, readJob, { job: "sweep" })),
        ).toMatchObject({
          holder: null,
          leaseUntil: null,
          progress: null,
          finishedAt: T0 + 10,
        });
        expect(
          ok(
            await storage.run(context(), at, takeJobLease, {
              ...lease,
              holder: "b",
              now: T0 + 20,
            }),
          ),
        ).toEqual({ taken: true, until: T0 + 1_020, progress: null });
      });

      test("a job never run reads as no row", async () => {
        const { storage } = store();
        expect(
          ok(
            await storage.run(context(), DIRECTORY_PARTITION, readJob, {
              job: "never",
            }),
          ),
        ).toBeNull();
      });
    });

    describe("two connections racing", () => {
      test("two concurrent conditional lease writes leave exactly one winner", async () => {
        const harness = store();
        const ports = [harness.storage, harness.connect()];
        const answers = await Promise.all(
          ports.map((storage, index) =>
            storage.run(context(), DIRECTORY_PARTITION, takeJobLease, {
              job: "sweep",
              holder: `run-${index}`,
              now: T0,
              leaseMs: 1_000,
            }),
          ),
        );
        const taken = answers.map((answer) => ok(answer).taken);
        expect(taken.filter(Boolean)).toHaveLength(1);
        const reads = await Promise.all(
          ports.map((storage, index) =>
            storage.run(context(), P, takeInFlightRead, {
              target: "pull:12",
              holder: `unit-${index}`,
              now: T0,
            }),
          ),
        );
        expect(
          reads.map((read) => ok(read).taken).filter(Boolean),
        ).toHaveLength(1);
      });
    });

    describe("the atomic batch", () => {
      test("results in order, every step committed", async () => {
        const { storage } = store();
        const results = ok(
          await storage.batch(context(), P, [
            step(takeInFlightRead, { target: "a", holder: "u", now: T0 }),
            step(takeInFlightRead, { target: "a", holder: "v", now: T0 }),
            step(releaseInFlightRead, { target: "a", holder: "u" }),
          ]),
        );
        expect(results).toEqual([
          { taken: true, until: T0 + IN_FLIGHT_READ_MS },
          { taken: false, holder: "u", until: T0 + IN_FLIGHT_READ_MS },
          { released: true },
        ]);
      });

      test("a failing later step rolls back the earlier ones", async () => {
        const { storage } = store();
        const failed = await storage.batch(context(), P, [
          step(takeInFlightRead, { target: "a", holder: "u", now: T0 }),
          // A holder no column may hold breaks the row's constraint.
          step(takeInFlightRead, {
            target: "b",
            holder: null as unknown as string,
            now: T0,
          }),
        ]);
        expect(failed.ok ? null : failed.failure.code).toBe("refused");
        expect(
          ok(
            await storage.run(context(), P, readInFlightRead, { target: "a" }),
          ),
        ).toBeNull();
      });

      test("a step that reads is refused before anything runs", async () => {
        const { storage } = store();
        const refused = await storage.batch(context(), P, [
          step(takeInFlightRead, { target: "a", holder: "u", now: T0 }),
          step(readInFlightRead, { target: "a" }),
        ]);
        expect(refused.ok ? null : refused.failure.code).toBe("refused");
        expect(
          ok(
            await storage.run(context(), P, readInFlightRead, { target: "a" }),
          ),
        ).toBeNull();
      });
    });

    describe("trimming", () => {
      const trim = (before: number, limit: number) => ({
        table: "in_flight_reads",
        column: "deadline_at",
        before,
        limit,
      });

      test("deletes the partition's oldest expired rows, at most the limit, and nothing else", async () => {
        const { storage } = store();
        for (const [partition, offsets] of [
          [P, [0, 1, 2, 3, 100]],
          [OTHER, [0]],
        ] as const)
          for (const offset of offsets)
            ok(
              await storage.run(context(), partition, takeInFlightRead, {
                target: `t${offset}`,
                holder: "h",
                now: T0 + offset,
              }),
            );
        const cutoff = T0 + IN_FLIGHT_READ_MS + 50;
        expect(
          ok(await storage.run(context(), P, trimExpired, trim(cutoff, 3))),
        ).toEqual({ deleted: 3 });
        const left = async (partition: string, target: string) =>
          ok(
            await storage.run(context(), partition, readInFlightRead, {
              target,
            }),
          ) !== null;
        expect(
          await Promise.all(
            ["t0", "t1", "t2", "t3", "t100"].map((t) => left(P, t)),
          ),
        ).toEqual([false, false, false, true, true]);
        expect(
          ok(await storage.run(context(), P, trimExpired, trim(cutoff, 3))),
        ).toEqual({ deleted: 1 });
        expect(await left(P, "t100")).toBe(true);
        expect(await left(OTHER, "t0")).toBe(true);
      });

      test("a table or column no rule names, or a limit below 1, is refused", async () => {
        const { storage } = store();
        for (const input of [
          { ...trim(T0, 10), table: "job_leases" },
          { ...trim(T0, 10), column: "taken_at" },
          { ...trim(T0, 10), table: "__proto__" },
          trim(T0, 0),
        ]) {
          const refused = await storage.run(context(), P, trimExpired, input);
          expect(refused.ok ? null : refused.failure.code).toBe("refused");
        }
      });
    });
  });
}
