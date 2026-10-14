import { describe, expect, test } from "bun:test";
import {
  type Clock,
  pollUntil,
  systemClock,
  systemSleep,
  type Timer,
} from "./poll-until.ts";

/** A clock that moves only when the injected sleep is called. */
function fakeTime(): {
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
  advance: (ms: number) => void;
} {
  let now = 1_000_000;
  const slept: number[] = [];
  return {
    clock: { now: () => now },
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
    slept,
    advance: (ms) => {
      now += ms;
    },
  };
}

/** A deadline timer that fires only when the test says so, recording what it was asked for. */
function manualTimer(): {
  timer: Timer;
  requested: number[];
  fireLatest: () => void;
} {
  const pending: { ms: number; fire: () => void; live: boolean }[] = [];
  return {
    timer: (ms, fire) => {
      const entry = { ms, fire, live: true };
      pending.push(entry);
      return () => {
        entry.live = false;
      };
    },
    get requested() {
      return pending.map((entry) => entry.ms);
    },
    fireLatest: () => {
      const entry = pending.at(-1);
      if (entry?.live) entry.fire();
    },
  };
}

/** Let pending promise callbacks run, so the wait reaches its next await. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * How a promise ends: "resolved", "rejected: <message>", or "pending" when it
 * has not settled within a second of real time. A promise that should settle
 * but never does then fails its test instead of hanging the run.
 */
async function outcome(promise: Promise<unknown>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Promise<string>((resolve) => {
    // fixed-delay: a deadline on a promise that must settle, not a wait for state
    timer = setTimeout(() => resolve("pending"), 1000);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "resolved",
        (error) =>
          `rejected: ${error instanceof Error ? error.message : String(error)}`,
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("returns the first value that is there, without waiting further", async () => {
  const time = fakeTime();
  let checks = 0;
  const value = await pollUntil({
    check: () => (++checks === 3 ? { id: "order-1" } : null),
    waitingFor: "order-1 to be visible",
    deadlineMs: 10_000,
    intervalMs: 500,
    ...time,
  });
  expect(value).toEqual({ id: "order-1" });
  expect(checks).toBe(3);
  expect(time.slept).toEqual([500, 500]);
});

test("a falsy value that is not null or undefined counts as arrived", async () => {
  const time = fakeTime();
  expect(
    await pollUntil({
      check: () => 0,
      waitingFor: "the queue to drain",
      deadlineMs: 1000,
      intervalMs: 100,
      ...time,
    }),
  ).toBe(0);
  expect(time.slept).toEqual([]);
});

test("fails at the deadline, naming what it waited for", async () => {
  const time = fakeTime();
  const wait = pollUntil({
    check: async () => undefined,
    waitingFor: "invoice INV-7 to be issued",
    deadlineMs: 1200,
    intervalMs: 500,
    ...time,
  });
  await expect(wait).rejects.toThrow(
    "timed out after 1200ms waiting for invoice INV-7 to be issued (3 checks)",
  );
  // The last pause is shortened so the wait never runs past the deadline,
  // and no check starts once the deadline is reached.
  expect(time.slept).toEqual([500, 500, 200]);
});

test("a value that arrives after the deadline is refused", async () => {
  const time = fakeTime();
  await expect(
    pollUntil({
      // Takes 100ms of clock time, synchronously, then answers.
      check: () => {
        time.advance(100);
        return "late";
      },
      waitingFor: "the slow answer",
      deadlineMs: 50,
      intervalMs: 10,
      ...time,
    }),
  ).rejects.toThrow(
    "timed out after 100ms waiting for the slow answer (1 checks)",
  );
});

test("a hanging check is cut off at the requested deadline, and its signal aborts", async () => {
  const time = fakeTime();
  const deadline = manualTimer();
  let seen: AbortSignal | undefined;
  const wait = pollUntil({
    check: (signal) => {
      seen = signal;
      return new Promise<null>(() => undefined);
    },
    waitingFor: "the export job to answer",
    deadlineMs: 50,
    intervalMs: 10,
    ...time,
    ...deadline,
  });
  await settle();
  expect(deadline.requested).toEqual([50]);
  expect(seen?.aborted).toBe(false);
  deadline.fireLatest();
  await expect(wait).rejects.toThrow(
    "timed out after 0ms waiting for the export job to answer (1 checks)",
  );
  expect(seen?.aborted).toBe(true);
});

test("a hanging pause is cut off at the deadline too", async () => {
  const time = fakeTime();
  const deadline = manualTimer();
  const wait = pollUntil({
    check: () => null,
    waitingFor: "the queue to drain",
    deadlineMs: 50,
    intervalMs: 10,
    clock: time.clock,
    sleep: () => new Promise<void>(() => undefined),
    ...deadline,
  });
  await settle();
  expect(deadline.requested).toEqual([50, 50]);
  deadline.fireLatest();
  await expect(wait).rejects.toThrow(
    "timed out after 0ms waiting for the queue to drain (1 checks)",
  );
});

test("the caller can cancel the wait, which aborts the check's signal", async () => {
  const time = fakeTime();
  const deadline = manualTimer();
  const caller = new AbortController();
  let seen: AbortSignal | undefined;
  const wait = pollUntil({
    check: (signal) => {
      seen = signal;
      return new Promise<null>(() => undefined);
    },
    waitingFor: "the export job to answer",
    deadlineMs: 50,
    intervalMs: 10,
    signal: caller.signal,
    ...time,
    ...deadline,
  });
  await settle();
  caller.abort(new Error("test torn down"));
  await expect(wait).rejects.toThrow("test torn down");
  expect(seen?.aborted).toBe(true);
});

test("an error from the check is not swallowed", async () => {
  const time = fakeTime();
  await expect(
    pollUntil({
      check: () => {
        throw new Error("connection refused");
      },
      waitingFor: "the service",
      deadlineMs: 1000,
      intervalMs: 100,
      ...time,
    }),
  ).rejects.toThrow("connection refused");
});

test.each([
  [0, 100],
  [1000, 0],
  [Number.NaN, 100],
  [Number.POSITIVE_INFINITY, 100],
  [1000, Number.POSITIVE_INFINITY],
])(
  "deadline %p and interval %p are rejected",
  async (deadlineMs, intervalMs) => {
    await expect(
      pollUntil({
        check: () => 1,
        waitingFor: "anything",
        deadlineMs,
        intervalMs,
      }),
    ).rejects.toThrow("must be positive and finite");
  },
);

test("with the real timer, a check that hangs is cut off with the same message", async () => {
  const started = performance.now();
  await expect(
    pollUntil({
      check: () => new Promise<null>(() => undefined),
      waitingFor: "the export job to answer",
      deadlineMs: 50,
      intervalMs: 10,
    }),
  ).rejects.toThrow(
    /^timed out after \d+ms waiting for the export job to answer \(1 checks\)$/,
  );
  expect(performance.now() - started).toBeLessThan(2000);
});

test("a cancel that lands between steps stops the wait before the next one", async () => {
  const time = fakeTime();
  const deadline = manualTimer();
  const caller = new AbortController();
  let pauses = 0;
  const wait = pollUntil({
    // Answers "not yet", then cancels from a later promise callback: after this
    // check's step has settled, before the pause's step starts.
    check: () => {
      void Promise.resolve()
        .then(() => undefined)
        .then(() => caller.abort(new Error("test torn down")));
      return null;
    },
    waitingFor: "the queue to drain",
    deadlineMs: 50,
    intervalMs: 10,
    signal: caller.signal,
    clock: time.clock,
    sleep: () => {
      pauses++;
      return new Promise<void>(() => undefined);
    },
    ...deadline,
  });
  expect(await outcome(wait)).toBe("rejected: test torn down");
  expect(pauses).toBe(0);
});

test("a cancel right after the call starts no check", async () => {
  const time = fakeTime();
  const caller = new AbortController();
  let checks = 0;
  const wait = pollUntil({
    check: () => {
      checks++;
      return 1;
    },
    waitingFor: "the queue to drain",
    deadlineMs: 50,
    intervalMs: 10,
    signal: caller.signal,
    clock: time.clock,
    sleep: time.sleep,
    ...manualTimer(),
  });
  caller.abort(new Error("test torn down"));
  expect(await outcome(wait)).toBe("rejected: test torn down");
  expect(checks).toBe(0);
});

test("a check queued before the deadline passes does not start after it", async () => {
  const time = fakeTime();
  let checks = 0;
  const wait = pollUntil({
    check: () => {
      checks++;
      return 1;
    },
    waitingFor: "the queue to drain",
    deadlineMs: 50,
    intervalMs: 10,
    clock: time.clock,
    sleep: time.sleep,
    ...manualTimer(),
  });
  // The deadline passes before the queued check gets its turn.
  time.advance(100);
  expect(await outcome(wait)).toBe(
    "rejected: timed out after 100ms waiting for the queue to drain (0 checks)",
  );
  expect(checks).toBe(0);
});

test("a cancel that lands after the check's step settles refuses its value", async () => {
  const time = fakeTime();
  const caller = new AbortController();
  const wait = pollUntil({
    check: () => 1,
    waitingFor: "the queue to drain",
    deadlineMs: 50,
    intervalMs: 10,
    signal: caller.signal,
    clock: time.clock,
    sleep: time.sleep,
    // The step cancels its deadline timer as it settles: the abort lands
    // after the check's value is in, before the wait returns it.
    timer: () => () => caller.abort(new Error("test torn down")),
  });
  expect(await outcome(wait)).toBe("rejected: test torn down");
});

test("a clock that fails at the deadline still ends the wait and aborts the check", async () => {
  let failing = false;
  const deadline = manualTimer();
  let seen: AbortSignal | undefined;
  const wait = pollUntil({
    check: (signal) => {
      seen = signal;
      return new Promise<null>(() => undefined);
    },
    waitingFor: "the export job to answer",
    deadlineMs: 50,
    intervalMs: 10,
    clock: {
      now: () => {
        if (failing) throw new Error("clock unavailable");
        return 0;
      },
    },
    ...deadline,
  });
  await settle();
  failing = true;
  expect(() => deadline.fireLatest()).not.toThrow();
  expect(await outcome(wait)).toBe("rejected: clock unavailable");
  expect(seen?.aborted).toBe(true);
});

test("a clock that fails at the start leaves no listener on the caller's signal", async () => {
  const caller = new AbortController();
  let listeners = 0;
  const add = caller.signal.addEventListener.bind(caller.signal);
  const remove = caller.signal.removeEventListener.bind(caller.signal);
  caller.signal.addEventListener = (...args: Parameters<typeof add>) => {
    listeners++;
    add(...args);
  };
  caller.signal.removeEventListener = (...args: Parameters<typeof remove>) => {
    listeners--;
    remove(...args);
  };
  await expect(
    pollUntil({
      check: () => 1,
      waitingFor: "anything",
      deadlineMs: 1000,
      intervalMs: 100,
      signal: caller.signal,
      clock: {
        now: () => {
          throw new Error("clock unavailable");
        },
      },
    }),
  ).rejects.toThrow("clock unavailable");
  expect(listeners).toBe(0);
});

describe("systemSleep", () => {
  /** A signal that counts the listeners currently registered on it. */
  function counted(): { controller: AbortController; live: () => number } {
    const controller = new AbortController();
    const signal = controller.signal;
    const handlers = new Set<unknown>();
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      handlers.add(args[1]);
      add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      handlers.delete(args[1]);
      remove(...args);
    };
    return { controller, live: () => handlers.size };
  }

  test("settles when its signal aborts during the pause", async () => {
    const controller = new AbortController();
    const pause = systemSleep(60_000, controller.signal);
    controller.abort(new Error("cancelled"));
    expect(await outcome(pause)).toBe("rejected: cancelled");
  });

  test("settles at once on a signal that has already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    expect(await outcome(systemSleep(60_000, controller.signal))).toBe(
      "rejected: cancelled",
    );
  });

  test("removes its listener when the pause completes", async () => {
    const { controller, live } = counted();
    await systemSleep(1, controller.signal);
    await systemSleep(1, controller.signal);
    expect(live()).toBe(0);
  });
});

test("the system clock is monotonic, so a wall-clock adjustment cannot move the deadline", () => {
  // performance.now() counts from the process start; Date.now() from 1970.
  expect(Math.abs(systemClock.now() - performance.now())).toBeLessThan(1000);
});
