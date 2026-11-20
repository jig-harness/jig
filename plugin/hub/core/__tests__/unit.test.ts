import { describe, expect, test } from "bun:test";
import { Defect, ok } from "../../../shared/outcome.ts";
import type { JobHandler, JobRun } from "../scheduling.ts";
import { operation } from "../storage.ts";
import { runUnit, type UnitContext } from "../unit.ts";
import { fakePorts } from "./fake-ports.ts";

/** Resolves when `signal` aborts: the work waits on the signal, not a timer. */
function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

const counter = operation<{ count: number }, { count: number }>(
  "setCount",
  "change",
);

describe("a unit's context", () => {
  test("every port call receives the unit's one signal and deadline", async () => {
    const ports = fakePorts();
    const stop = new AbortController();
    let given: UnitContext | undefined;
    const outcome = await runUnit(
      ports,
      { name: "test:every-port", timeoutMs: 5_000, stop: stop.signal },
      async (context) => {
        given = context;
        await ports.storage.run(context, "repo:o/r", counter, { count: 1 });
        await ports.serving.serve(context, async () =>
          ok({ status: 204, headers: {}, body: "" }),
        );
        await ports.scheduling.schedule(context, "sweep", { everyMs: 60_000 });
        await ports.scheduling.runSoon(context, "sweep");
        await ports.scheduling.cancel(context, "sweep");
        await ports.outbound.call(context, {
          system: "github",
          operation: "pullRequest",
          repository: "o/r",
          read: true,
          method: "GET",
          path: "/repos/o/r/pulls/1",
        });
        ports.observability.event(context, { name: "e", at: 0, fields: {} });
        ports.observability.metric(context, {
          name: "m",
          value: 1,
          at: 0,
          labels: {},
        });
        ports.observability.span(context, {
          name: "s",
          startedAt: 0,
          endedAt: 1,
          fields: {},
        });
        // The signal the work holds is the one the boundary aborts.
        stop.abort();
        return ok(context.signal.aborted ? "done" : "a signal of its own");
      },
    );
    expect(outcome).toEqual(ok("done"));
    expect(ports.calls.map((c) => c.call)).toEqual([
      "storage.setCount",
      "serving.serve",
      "scheduling.schedule",
      "scheduling.runSoon",
      "scheduling.cancel",
      "outbound.call",
      "observability.event",
      "observability.metric",
      "observability.span",
    ]);
    for (const { context } of ports.calls) {
      expect(context.signal).toBe(given?.signal as AbortSignal);
      expect(context.deadlineAt).toBe(1_800_000_005_000);
      expect(context.unit).toBe("test:every-port");
    }
  });

  test("the deadline is the injected clock's now plus the timeout, in whole milliseconds", async () => {
    const ports = fakePorts(42);
    const outcome = await runUnit(
      ports,
      { name: "test:deadline", timeoutMs: 250 },
      async (context) => ok(context.deadlineAt),
    );
    expect(outcome).toEqual(ok(292));
  });
});

describe("a job's run", () => {
  test("runs as one unit, its storage calls under the unit's signal", async () => {
    const ports = fakePorts();
    const sweep: JobHandler = async (context, run) => {
      const stored = await ports.storage.run(context, "hub", counter, {
        count: run.dueAt,
      });
      return stored.ok ? ok(undefined) : stored;
    };
    const run: JobRun = { job: "sweep", dueAt: 7 };
    const outcome = await runUnit(
      ports,
      { name: "job:sweep", timeoutMs: 5_000 },
      (context) => sweep(context, run),
    );
    expect(outcome).toEqual(ok(undefined));
    expect(ports.rows.get("hub/setCount")).toEqual({ count: 7 });
    expect(ports.calls.map((c) => c.context.unit)).toEqual(["job:sweep"]);
  });
});

describe("the deadline", () => {
  test("its passing aborts the signal and answers deadline-passed", async () => {
    const ports = fakePorts();
    let signal: AbortSignal | undefined;
    const outcome = await runUnit(
      ports,
      { name: "test:late", timeoutMs: 20 },
      async (context) => {
        signal = context.signal;
        await aborted(context.signal);
        // A port call after the deadline sees the aborted signal.
        return ports.outbound.call(context, {
          system: "linear",
          operation: "Queue",
          repository: null,
          read: true,
          method: "POST",
          path: "/graphql",
        });
      },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("deadline-passed");
    expect(signal?.aborted).toBe(true);
    expect((signal?.reason as Error | undefined)?.name).toBe("TimeoutError");
    expect(ports.defects).toEqual([]);
  });

  test("answers without waiting for work that never looks at the signal", async () => {
    const ports = fakePorts();
    const outcome = await runUnit(
      ports,
      { name: "test:stuck", timeoutMs: 20 },
      // A promise nothing ever settles.
      () => new Promise<never>(() => undefined),
    );
    expect(outcome.ok ? null : outcome.failure.code).toBe("deadline-passed");
  });

  test("the adapter's stop signal aborts the unit's", async () => {
    const ports = fakePorts();
    const stop = new AbortController();
    const outcome = await runUnit(
      ports,
      { name: "test:stop", timeoutMs: 60_000, stop: stop.signal },
      async (context) => {
        stop.abort();
        await aborted(context.signal);
        return ports.storage.run(context, "hub", counter, { count: 2 });
      },
    );
    expect(outcome.ok ? null : outcome.failure.code).toBe("aborted");
  });
});

describe("the defect boundary", () => {
  test("a thrown non-defect becomes a reported Defect, and the unit fails with code defect", async () => {
    const ports = fakePorts();
    const outcome = await runUnit(
      ports,
      { name: "test:throws", timeoutMs: 5_000 },
      async () => {
        throw new TypeError("x is undefined");
      },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.code).toBe("defect");
    expect(outcome.failure.cause).toBeInstanceOf(Defect);
    expect(ports.defects).toHaveLength(1);
    const [defect] = ports.defects;
    expect(defect).toBeInstanceOf(Defect);
    expect(defect?.message).toContain("x is undefined");
    expect(defect?.cause).toBeInstanceOf(TypeError);
  });

  test("a Defect is reported as itself, and a synchronous throw is caught too", async () => {
    const ports = fakePorts();
    const thrown = new Defect("a broken invariant");
    const outcome = await runUnit(
      ports,
      { name: "test:defect", timeoutMs: 5_000 },
      () => {
        throw thrown;
      },
    );
    expect(outcome.ok ? null : outcome.failure.code).toBe("defect");
    expect(ports.defects).toEqual([thrown]);
  });

  test("a work's own failure passes through unchanged and reports nothing", async () => {
    const ports = fakePorts();
    const outcome = await runUnit(
      ports,
      { name: "test:failed", timeoutMs: 5_000 },
      async () => ({
        ok: false as const,
        failure: { code: "not-enrolled", reason: "the host is not enrolled" },
      }),
    );
    expect(outcome).toEqual({
      ok: false,
      failure: { code: "not-enrolled", reason: "the host is not enrolled" },
    });
    expect(ports.defects).toEqual([]);
  });

  test("a timeout that is not a positive whole number is a defect, never a throw", async () => {
    for (const timeoutMs of [0, -1, 1.5, Number.NaN]) {
      const ports = fakePorts();
      const outcome = await runUnit(
        ports,
        { name: "test:bad-timeout", timeoutMs },
        async () => ok(1),
      );
      expect(outcome.ok ? null : outcome.failure.code).toBe("defect");
      expect(ports.defects).toHaveLength(1);
    }
  });

  test("a throwing reporter leaves the unit's failed outcome", async () => {
    const ports = fakePorts();
    const outcome = await runUnit(
      {
        ...ports,
        observability: {
          ...ports.observability,
          defect: () => {
            throw new Error("the log is gone");
          },
        },
      },
      { name: "test:reporter", timeoutMs: 5_000 },
      async () => {
        throw new Error("first");
      },
    );
    expect(outcome.ok ? null : outcome.failure.code).toBe("defect");
  });
});
