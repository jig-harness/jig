import { expect, test } from "bun:test";
import { Defect } from "../errors.ts";
import {
  poll,
  PollTimeoutError,
  retry,
  retryAttempts,
  retrySync,
  wait,
} from "../retry.ts";

function clock() {
  let time = 0;
  const waits: number[] = [];
  return {
    waits,
    now: () => time,
    sleep: async (ms: number) => {
      waits.push(ms);
      time += ms;
    },
  };
}

test("retry backs off with bounded jitter and keeps the final error", async () => {
  const timer = clock();
  const failure = new Error("failed");
  let calls = 0;
  await expect(
    retry(
      async () => {
        calls++;
        throw failure;
      },
      {
        attempts: 4,
        baseMs: 10,
        maxMs: 15,
        retryIf: () => true,
        clock: timer,
        random: () => 1,
      },
    ),
  ).rejects.toBe(failure);
  expect(calls).toBe(4);
  expect(timer.waits).toEqual([10, 15, 15]);
});

test("retryIf refuses terminal errors and sync retries preserve synchronous return", async () => {
  const timer = clock();
  let calls = 0;
  await expect(
    retry(
      () => {
        calls++;
        throw new Error("terminal");
      },
      { attempts: 3, baseMs: 1, maxMs: 2, retryIf: () => false, clock: timer },
    ),
  ).rejects.toThrow("terminal");
  expect(calls).toBe(1);
  expect(timer.waits).toEqual([]);
  expect(
    retrySync(
      () => {
        if (++calls < 3) throw new Error("race");
        return 42;
      },
      { attempts: 3, retryIf: () => true },
    ),
  ).toBe(42);
});

test("poll clips sleeps to its deadline and never probes after expiration", async () => {
  const timer = clock();
  let calls = 0;
  await expect(
    poll(() => ++calls, {
      everyMs: 8,
      deadlineMs: 10,
      until: () => false,
      clock: timer,
    }),
  ).rejects.toBeInstanceOf(PollTimeoutError);
  expect(calls).toBe(2);
  expect(timer.waits).toEqual([8, 2]);
});

test("poll returns the value satisfying its predicate", async () => {
  const timer = clock();
  let calls = 0;
  expect(
    await poll(() => ++calls, {
      everyMs: 1,
      deadlineMs: 10,
      until: (value) => value === 2,
      clock: timer,
    }),
  ).toBe(2);
});

test("abort during injected unresponsive sleep stops retries", async () => {
  const abort = new AbortController();
  let calls = 0;
  const task = retry(
    () => {
      calls++;
      throw new Error("transient");
    },
    {
      attempts: 3,
      retryIf: () => true,
      baseMs: 1,
      maxMs: 2,
      signal: abort.signal,
      clock: {
        now: () => 0,
        sleep: () =>
          new Promise(() => {
            /* This injected clock deliberately never wakes. */
          }),
      },
    },
  );
  await Promise.resolve();
  abort.abort(new Error("cancelled"));
  await expect(task).rejects.toThrow("cancelled");
  expect(calls).toBe(1);
});

test("poll immediate allows a free resource at a zero deadline", async () => {
  const timer = clock();
  expect(
    await poll(() => true, {
      everyMs: 1,
      deadlineMs: 0,
      immediate: true,
      until: (value) => value,
      clock: timer,
    }),
  ).toBe(true);
  expect(timer.waits).toEqual([]);
});

test("abort during a probe refuses its late result", async () => {
  const abort = new AbortController();
  await expect(
    retry(
      () => {
        abort.abort(new Error("cancelled"));
        return 42;
      },
      {
        attempts: 2,
        baseMs: 1,
        maxMs: 2,
        retryIf: () => true,
        signal: abort.signal,
      },
    ),
  ).rejects.toThrow("cancelled");
});

test("stateful retry attempts stop without a pause when the protocol breaks", async () => {
  const timer = clock();
  const seen: number[] = [];
  for await (const attempt of retryAttempts({
    attempts: 3,
    baseMs: 10,
    maxMs: 20,
    random: () => 1,
    clock: timer,
  })) {
    seen.push(attempt);
    break;
  }
  expect(seen).toEqual([1]);
  expect(timer.waits).toEqual([]);
});

test("stateful retry attempts pace only the bounded subsequent attempts", async () => {
  const timer = clock();
  const seen: number[] = [];
  for await (const attempt of retryAttempts({
    attempts: 4,
    baseMs: 10,
    maxMs: 15,
    random: () => 1,
    clock: timer,
  }))
    seen.push(attempt);
  expect(seen).toEqual([1, 2, 3, 4]);
  expect(timer.waits).toEqual([10, 15, 15]);
});

test("sync retry refuses a result produced during cancellation", () => {
  const abort = new AbortController();
  expect(() =>
    retrySync(
      () => {
        abort.abort(new Error("cancelled"));
        return 42;
      },
      { attempts: 2, retryIf: () => true, signal: abort.signal },
    ),
  ).toThrow("cancelled");
});

test("abort settles retry and poll while a callback never settles", async () => {
  const never = () => new Promise<never>(() => undefined);
  for (const run of [
    (signal: AbortSignal) =>
      retry(never, {
        attempts: 2,
        baseMs: 1,
        maxMs: 2,
        retryIf: () => true,
        signal,
      }),
    (signal: AbortSignal) =>
      poll(never, {
        everyMs: 1,
        deadlineMs: Number.MAX_SAFE_INTEGER,
        until: () => true,
        signal,
      }),
  ]) {
    const abort = new AbortController();
    const pending = run(abort.signal);
    abort.abort(new Error("cancelled"));
    await expect(pending).rejects.toThrow("cancelled");
  }
});

test("retry refuses delays the timer cannot honour", async () => {
  for (const [baseMs, maxMs] of [
    [-1, 10],
    [Number.NaN, 10],
    [10, Number.POSITIVE_INFINITY],
    [10, 2 ** 31],
  ] as const) {
    await expect(
      retry(() => 1, { attempts: 2, baseMs, maxMs, retryIf: () => true }),
    ).rejects.toThrow(Defect);
    const attempts = retryAttempts({ attempts: 2, baseMs, maxMs });
    await expect(attempts.next()).rejects.toThrow(Defect);
  }
});

test("abort raised by a callback that then never settles still settles retry and poll", async () => {
  const abortThenHang = (abort: AbortController) => () => {
    abort.abort(new Error("cancelled"));
    return new Promise<never>(() => undefined);
  };
  for (const run of [
    (abort: AbortController) =>
      retry(abortThenHang(abort), {
        attempts: 2,
        retryIf: () => true,
        baseMs: 1,
        maxMs: 2,
        signal: abort.signal,
      }),
    (abort: AbortController) =>
      poll(abortThenHang(abort), {
        everyMs: 1,
        deadlineMs: Number.MAX_SAFE_INTEGER,
        until: () => true,
        signal: abort.signal,
      }),
  ])
    await expect(run(new AbortController())).rejects.toThrow("cancelled");
});

test("poll refuses intervals the timer cannot honour", async () => {
  for (const everyMs of [0, 2 ** 31, Number.POSITIVE_INFINITY, Number.NaN])
    await expect(
      poll(() => false, {
        everyMs,
        deadlineMs: Number.MAX_SAFE_INTEGER,
        until: () => false,
        clock: clock(),
      }),
    ).rejects.toThrow(Defect);
  await expect(wait(2 ** 31)).rejects.toThrow(Defect);
});
