/**
 * The job helper and the trimming job on the real store (`bun:sqlite`):
 * a run resumes from the progress a stopped run stored, two runs of one
 * job never overlap, and the trimming job walks every partition and rule
 * in chunks.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failed, ok } from "../../../shared/outcome.ts";
import { fakePorts } from "../../core/__tests__/fake-ports.ts";
import { runJob } from "../../core/jobs.ts";
import {
  IN_FLIGHT_READ_MS,
  readInFlightRead,
  readJob,
  takeInFlightRead,
} from "../../core/operations.ts";
import {
  DIRECTORY_PARTITION,
  repositoryPartition,
} from "../../core/partitions.ts";
import type { HubPorts } from "../../core/ports.ts";
import {
  RETENTION,
  scheduleTrimming,
  TRIM_EVERY_MS,
  TRIM_JOB,
  trimmingHandler,
} from "../../core/trimming.ts";
import type { UnitContext } from "../../core/unit.ts";
import { openHubSqlite } from "../../process/sqlite.ts";
import { createStorage } from "../storage.ts";

const scratch = mkdtempSync(join(tmpdir(), "hub-jobs-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let opened = 0;
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** The fake ports with the real store behind `storage`. */
function portsWithStore() {
  const sqlite = openHubSqlite(join(scratch, `jobs-${++opened}.sqlite`));
  if (!sqlite.ok) throw new Error(sqlite.failure.reason);
  closers.push(() => sqlite.value.close());
  const ports = fakePorts();
  return Object.assign(ports, {
    storage: createStorage(sqlite.value.db),
  }) as typeof ports & Pick<HubPorts, "storage">;
}

/** Resolves when `signal` aborts. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** A promise and the function that settles it. */
function gate(): { opened: Promise<void>; open: () => void } {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { opened: promise, open: () => resolve() };
}

const JOB = { job: "five-steps", partition: DIRECTORY_PARTITION };
type Progress = { next: number };

describe("a job's run", () => {
  test("a run stopped mid-run is resumed from its stored progress once its lease lapses", async () => {
    const ports = portsWithStore();
    const finished: number[] = [];
    const stop = new AbortController();
    const step = async (context: UnitContext, progress: Progress | null) => {
      const next = progress?.next ?? 0;
      if (next === 2 && !stop.signal.aborted) {
        // The adapter stops the run during its third step.
        stop.abort();
        await aborted(context.signal);
        return failed("aborted", "stopped");
      }
      finished.push(next);
      return ok({ progress: { next: next + 1 }, done: next === 4 });
    };
    const spec = { ...JOB, timeoutMs: 5_000, leaseMs: 5_000 };

    const first = await runJob(ports, { ...spec, stop: stop.signal }, step);
    expect(first.ok ? null : first.failure.code).toBe("aborted");
    expect(finished).toEqual([0, 1]);

    // Before the lease lapses, no other run starts.
    const early = await runJob(ports, spec, step);
    expect(early.ok && !early.value.ran).toBe(true);
    expect(finished).toEqual([0, 1]);

    ports.advance(5_000);
    const second = await runJob(ports, spec, step);
    expect(second).toEqual({ ok: true, value: { ran: true, steps: 3 } });
    expect(finished).toEqual([0, 1, 2, 3, 4]);
    const row = await ports.storage.run(
      { unit: "test", signal: new AbortController().signal, deadlineAt: 0 },
      DIRECTORY_PARTITION,
      readJob,
      { job: JOB.job },
    );
    expect(row.ok ? row.value : null).toMatchObject({
      holder: null,
      progress: null,
      finishedAt: ports.clock.now(),
    });
  });

  test("a spec whose lease is shorter than its timeout is refused before it runs", async () => {
    const ports = portsWithStore();
    let stepped = false;
    const outcome = await runJob(
      ports,
      { ...JOB, timeoutMs: 5_000, leaseMs: 4_999 },
      async () => {
        stepped = true;
        return ok({ progress: { next: 1 }, done: true });
      },
    );
    expect(outcome.ok ? null : outcome.failure.code).toBe("defect");
    expect(stepped).toBe(false);
    expect(ports.defects).toHaveLength(1);
    const row = await ports.storage.run(
      { unit: "test", signal: new AbortController().signal, deadlineAt: 0 },
      DIRECTORY_PARTITION,
      readJob,
      { job: JOB.job },
    );
    expect(row).toEqual(ok(null));
  });

  test("a run given another live run's holder id does not run", async () => {
    const ports = portsWithStore();
    const inStep = gate();
    const release = gate();
    const ran: string[] = [];
    const spec = { ...JOB, timeoutMs: 5_000, leaseMs: 5_000, holder: "same" };
    const step = (run: string) => async () => {
      ran.push(run);
      if (run === "first") {
        inStep.open();
        await release.opened;
      }
      return ok({ progress: { next: 1 }, done: true });
    };
    const first = runJob(ports, spec, step("first"));
    await inStep.opened;
    const second = await runJob(ports, spec, step("second"));
    expect(second.ok && !second.value.ran).toBe(true);
    release.open();
    expect(await first).toEqual({ ok: true, value: { ran: true, steps: 1 } });
    expect(ran).toEqual(["first"]);
  });

  test("two runs of one job never overlap", async () => {
    const ports = portsWithStore();
    const inStep = gate();
    const release = gate();
    const ran: string[] = [];
    const step =
      (run: string) =>
      async (_context: UnitContext, progress: Progress | null) => {
        ran.push(run);
        if (run === "first") {
          inStep.open();
          await release.opened;
        }
        return ok({
          progress: { next: (progress?.next ?? 0) + 1 },
          done: true,
        });
      };
    const spec = { ...JOB, timeoutMs: 5_000, leaseMs: 60_000 };
    const first = runJob(ports, { ...spec, holder: "first" }, step("first"));
    await inStep.opened;
    const second = await runJob(
      ports,
      { ...spec, holder: "second" },
      step("second"),
    );
    expect(second).toEqual({
      ok: true,
      value: { ran: false, holder: "first", until: ports.clock.now() + 60_000 },
    });
    release.open();
    expect(await first).toEqual({ ok: true, value: { ran: true, steps: 1 } });
    expect(ran).toEqual(["first"]);
  });

  test("a run whose lease another run took over stops at its next save", async () => {
    const ports = portsWithStore();
    const steps: number[] = [];
    const spec = { ...JOB, timeoutMs: 5_000, leaseMs: 5_000 };
    const outcome = await runJob(
      ports,
      { ...spec, holder: "slow" },
      async (_context, progress: Progress | null) => {
        const next = progress?.next ?? 0;
        steps.push(next);
        // The store's clock passes the lease while the run's own timer has
        // not fired, and another run takes the job over.
        ports.advance(5_000);
        const other = await ports.storage.run(
          {
            unit: "other",
            signal: new AbortController().signal,
            deadlineAt: 0,
          },
          DIRECTORY_PARTITION,
          (await import("../../core/operations.ts")).takeJobLease,
          {
            job: JOB.job,
            holder: "fast",
            now: ports.clock.now(),
            leaseMs: 1_000,
          },
        );
        expect(other.ok && other.value.taken).toBe(true);
        return ok({ progress: { next: next + 1 }, done: false });
      },
    );
    expect(outcome.ok ? null : outcome.failure.code).toBe("lease-lost");
    expect(steps).toEqual([0]);
  });
});

describe("the trimming job", () => {
  const unit = (): UnitContext => ({
    unit: "job:trim",
    signal: new AbortController().signal,
    deadlineAt: Number.MAX_SAFE_INTEGER,
  });

  test("is scheduled every hour", async () => {
    const ports = fakePorts();
    expect(await scheduleTrimming(ports, unit())).toEqual(ok(undefined));
    expect(ports.calls.map((c) => c.call)).toEqual(["scheduling.schedule"]);
    expect(TRIM_EVERY_MS).toBe(60 * 60 * 1000);
    expect(RETENTION.auditTrail).toBe(365 * 24 * 60 * 60 * 1000);
  });

  test("deletes every partition's expired rows in chunks, and keeps the rest", async () => {
    const ports = portsWithStore();
    const partitions = [
      repositoryPartition("acme/widgets"),
      repositoryPartition("acme/gears"),
    ] as const;
    const start = ports.clock.now();
    for (const partition of partitions)
      for (let i = 0; i < 5; i++)
        await ports.storage.run(unit(), partition, takeInFlightRead, {
          target: `old-${i}`,
          holder: "h",
          now: start,
        });
    ports.advance(IN_FLIGHT_READ_MS + RETENTION.inFlightReadAfterDeadline);
    for (const partition of partitions)
      await ports.storage.run(unit(), partition, takeInFlightRead, {
        target: "fresh",
        holder: "h",
        now: ports.clock.now(),
      });
    ports.advance(1);
    const trims: string[] = [];
    const storage = ports.storage;
    const counting = Object.assign(Object.create(storage), {
      run: ((context, partition, op, input) => {
        if (op.name === "trimExpired") trims.push(partition);
        return storage.run(context, partition, op, input);
      }) as typeof storage.run,
    });
    const handler = trimmingHandler(
      { ...ports, storage: counting },
      { partitions: async () => ok(partitions), chunk: 2 },
    );
    expect(await handler(unit(), { job: TRIM_JOB, dueAt: 0 })).toEqual(
      ok(undefined),
    );
    // Five rows a partition in chunks of two: three trims each, sorted.
    const [widgets, gears] = partitions;
    expect(trims).toEqual([gears, gears, gears, widgets, widgets, widgets]);
    for (const partition of partitions) {
      for (let i = 0; i < 5; i++) {
        const row = await ports.storage.run(
          unit(),
          partition,
          readInFlightRead,
          {
            target: `old-${i}`,
          },
        );
        expect(row).toEqual(ok(null));
      }
      const fresh = await ports.storage.run(
        unit(),
        partition,
        readInFlightRead,
        {
          target: "fresh",
        },
      );
      expect(fresh.ok && fresh.value !== null).toBe(true);
    }
  });

  test("a partition that does not parse is skipped and reported, and the rest are trimmed", async () => {
    const ports = portsWithStore();
    const good = repositoryPartition("acme/widgets");
    await ports.storage.run(unit(), good, takeInFlightRead, {
      target: "old",
      holder: "h",
      now: ports.clock.now(),
    });
    ports.advance(IN_FLIGHT_READ_MS + RETENTION.inFlightReadAfterDeadline + 1);
    // "acme/broken" sorts before the good partition's name.
    const handler = trimmingHandler(ports, {
      partitions: async () => ok(["acme/broken", good]),
    });
    expect(await handler(unit(), { job: TRIM_JOB, dueAt: 0 })).toEqual(
      ok(undefined),
    );
    expect(
      await ports.storage.run(unit(), good, readInFlightRead, {
        target: "old",
      }),
    ).toEqual(ok(null));
    expect(
      ports.calls
        .filter((c) => c.call === "observability.event")
        .map((c) => c.call),
    ).toEqual(["observability.event"]);
    const job = await ports.storage.run(unit(), DIRECTORY_PARTITION, readJob, {
      job: TRIM_JOB,
    });
    expect(job.ok ? job.value?.finishedAt : null).toBe(ports.clock.now());
  });

  test("a stopped trimming run resumes at the partition it was on", async () => {
    const ports = portsWithStore();
    const partitions = ["repo:a/one", "repo:a/three", "repo:a/two"] as const;
    const seen: string[] = [];
    const stop = new AbortController();
    const storage = ports.storage;
    const stopping = Object.assign(Object.create(storage), {
      run: ((context, partition, op, input) => {
        if (op.name === "trimExpired") {
          seen.push(partition);
          if (seen.length === 2) stop.abort();
        }
        return storage.run(context, partition, op, input);
      }) as typeof storage.run,
    });
    const handler = trimmingHandler(
      { ...ports, storage: stopping },
      { partitions: async () => ok(partitions) },
    );
    const stopped = await handler(
      { ...unit(), signal: stop.signal },
      { job: TRIM_JOB, dueAt: 0 },
    );
    expect(stopped.ok ? null : stopped.failure.code).toBe("aborted");
    ports.advance(10 * 60 * 1000);
    expect(await handler(unit(), { job: TRIM_JOB, dueAt: 0 })).toEqual(
      ok(undefined),
    );
    // The second run starts at the second partition, whose trim the stop interrupted.
    expect(seen).toEqual([
      partitions[0],
      partitions[1],
      partitions[1],
      partitions[2],
    ]);
  });
});
