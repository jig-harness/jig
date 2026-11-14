/**
 * The library's one retry: a read that met a class retried once is sent
 * once more after its backoff, inside the call's deadline; a write, a
 * second failure and every other class are not.
 */
import { describe, expect, it } from "bun:test";
import {
  FAILURE_CLASSES,
  type FailureClass,
  type OutboundFailure,
  outboundFailure,
  retriedOnce,
} from "../outbound/failure.ts";
import {
  backoffMs,
  discardBody,
  MOST_WAIT_MS,
  retryRead,
  waitForRetry,
} from "../outbound/retry.ts";

/** A sender whose answers fail as `classes` in turn, then succeed; it counts what it sent. */
function sender(classes: (FailureClass | null)[], retryAfterMs?: number) {
  let sent = 0;
  const send = async (): Promise<OutboundFailure | "ok"> => {
    const code = classes[sent++] ?? null;
    return code === null
      ? "ok"
      : outboundFailure(code, `failed as ${code}`, {
          retryAfterMs: retryAfterMs ?? null,
        });
  };
  return { send, sent: () => sent };
}

const failureOf = (a: OutboundFailure | "ok") => (a === "ok" ? null : a);

function options(read: boolean, waits: number[] = []) {
  return {
    read,
    signal: new AbortController().signal,
    failureOf,
    wait: async (ms: number) => {
      waits.push(ms);
    },
    random: () => 0.5,
  };
}

describe("retryRead", () => {
  for (const code of FAILURE_CLASSES) {
    const once = retriedOnce(code);
    it(`${once ? "sends a read once more" : "does not send a read again"} after ${code}`, async () => {
      const s = sender([code]);
      const answer = await retryRead(s.send, options(true));
      expect(s.sent()).toBe(once ? 2 : 1);
      expect(answer === "ok").toBe(once);
    });
  }

  it("never sends a write twice", async () => {
    const s = sender(["unreachable"]);
    const answer = await retryRead(s.send, options(false));
    expect(s.sent()).toBe(1);
    expect(answer).toMatchObject({ code: "unreachable" });
  });

  it("sends a read at most twice", async () => {
    const s = sender(["server-fault", "server-fault", "server-fault"]);
    const answer = await retryRead(s.send, options(true));
    expect(s.sent()).toBe(2);
    expect(answer).toMatchObject({ code: "server-fault" });
  });

  it("waits the jittered backoff, or the system's longer ask", async () => {
    const waits: number[] = [];
    await retryRead(sender(["unreachable"]).send, options(true, waits));
    await retryRead(sender(["server-fault"], 7_000).send, options(true, waits));
    expect(waits).toEqual([1_000, 7_000]);
    expect(backoffMs(outboundFailure("unreachable", "x"), () => 0)).toBe(500);
    expect(backoffMs(outboundFailure("unreachable", "x"), () => 0.999)).toBe(
      1_499,
    );
  });

  it("does not wait past the call's deadline or longer than it may", async () => {
    const late = sender(["unreachable"]);
    await retryRead(late.send, {
      ...options(true),
      now: () => 1_000,
      deadlineAt: 1_500,
    });
    expect(late.sent()).toBe(1);
    const long = sender(["server-fault"], MOST_WAIT_MS + 1);
    await retryRead(long.send, options(true));
    expect(long.sent()).toBe(1);
  });

  it("sends a read again after a throw of a class retried once, and rethrows any other", async () => {
    let sent = 0;
    const flaky = async () => {
      if (++sent === 1) throw new TypeError("fetch failed");
      return "ok" as const;
    };
    const answer = await retryRead(flaky, {
      ...options(true),
      thrownFailure: () => outboundFailure("unreachable", "no answer"),
    });
    expect([answer, sent]).toEqual(["ok", 2]);
    let refused = 0;
    await expect(
      retryRead(async () => {
        refused++;
        throw new Error("bad request");
      }, options(true)),
    ).rejects.toThrow("bad request");
    expect(refused).toBe(1);
  });

  it("ends at the call's deadline during a wait, sending nothing more", async () => {
    const s = sender(["unreachable"]);
    await expect(
      retryRead(s.send, {
        read: true,
        signal: AbortSignal.timeout(10),
        failureOf,
        random: () => 0.5,
      }),
    ).rejects.toThrow();
    expect(s.sent()).toBe(1);
  });

  it("cancels a wait once it has started", async () => {
    const controller = new AbortController();
    const waiting = waitForRetry(30_000, controller.signal);
    controller.abort(new Error("wait cancelled"));
    await expect(waiting).rejects.toThrow("wait cancelled");
  });
});

describe("discardBody", () => {
  it("does not wait forever for a body whose cleanup never settles", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
          return new Promise<void>(() => {
            // The stream never settles its cancellation callback.
          });
        },
      }),
      { status: 503 },
    );
    const pending = discardBody(response, controller.signal);
    controller.abort(new Error("deadline elapsed"));
    await pending;
    expect(cancelled).toBe(true);
  });

  it("keeps the answer when cleanup fails", async () => {
    const response = new Response(
      new ReadableStream({
        cancel() {
          throw new Error("cleanup failed");
        },
      }),
      { status: 503 },
    );
    await discardBody(response);
    expect(response.status).toBe(503);
  });
});
