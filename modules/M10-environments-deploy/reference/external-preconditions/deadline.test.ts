import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GH_REQUEST_MS,
  ghProcess,
  remainingMs,
  withDeadline,
  withinDeadline,
} from "./deadline.ts";

const error = (message: string) => new Error(message);
const ok = { ok: true, stdout: "{}", stderr: "" };

describe("withinDeadline", () => {
  // These tests read the real clock, and a loaded machine can stall this
  // process for hundreds of milliseconds at any point. So no assertion
  // depends on how long a step took: a budget a request must fit in is far
  // longer than any stall, and the step that must run out of budget waits
  // until it has.
  test("bounds each request by the operation's remaining budget", async () => {
    const budgetMs = 10_000;
    const pauseMs = 20;
    expect(budgetMs).toBeLessThan(GH_REQUEST_MS);
    const timeouts: number[] = [];
    await withDeadline(
      budgetMs,
      "read",
      (signal) => {
        const gh = withinDeadline(
          (_args, timeoutMs) => {
            timeouts.push(timeoutMs);
            return ok;
          },
          signal,
          error,
        );
        gh(["first"]);
        Bun.sleepSync(pauseMs);
        gh(["second"]);
      },
      error,
    );
    const [first = NaN, second = NaN] = timeouts;
    expect(timeouts).toHaveLength(2);
    expect(first).toBeLessThanOrEqual(budgetMs);
    expect(second).toBeGreaterThanOrEqual(1);
    expect(second).toBeLessThanOrEqual(first - pauseMs);
  });
  test("starts no request once the deadline has passed", async () => {
    const calls: string[][] = [];
    await expect(
      withDeadline(
        20,
        "read",
        (signal) => {
          const gh = withinDeadline(
            (args) => {
              calls.push(args);
              return ok;
            },
            signal,
            error,
          );
          // Synchronous work holds the timer back, so the signal has not
          // aborted when the deadline passes; only the clock says it has.
          while (remainingMs(signal) >= 1) Bun.sleepSync(5);
          expect(signal.aborted).toBe(false);
          gh(["late"]);
        },
        error,
      ),
    ).rejects.toThrow("late not requested");
    expect(calls).toEqual([]);
  });
  test("a signal from no operation leaves only the request ceiling", () => {
    expect(remainingMs(new AbortController().signal)).toBe(Infinity);
    let seen = 0;
    withinDeadline(
      (_args, timeoutMs) => {
        seen = timeoutMs;
        return ok;
      },
      undefined,
      error,
    )(["x"]);
    expect(seen).toBe(GH_REQUEST_MS);
  });
  test("hands each request a whole number of milliseconds", async () => {
    const timeouts: number[] = [];
    await withDeadline(
      10_000.5,
      "read",
      (signal) =>
        withinDeadline(
          (_args, timeoutMs) => {
            timeouts.push(timeoutMs);
            return ok;
          },
          signal,
          error,
        )(["x"]),
      error,
    );
    expect(timeouts).toHaveLength(1);
    expect(Number.isInteger(timeouts[0])).toBe(true);
    expect(timeouts[0]).toBeGreaterThanOrEqual(1);
  });
  test("treats a sub-millisecond remainder as expired", async () => {
    const calls: string[][] = [];
    await expect(
      withDeadline(
        0.5,
        "read",
        (signal) =>
          withinDeadline(
            (args) => {
              calls.push(args);
              return ok;
            },
            signal,
            error,
          )(["x"]),
        error,
      ),
    ).rejects.toThrow("x not requested");
    expect(calls).toEqual([]);
  });
});

describe.skipIf(process.platform === "win32")("ghProcess", () => {
  test("runs a request through the real spawn within an operation", async () => {
    const bin = mkdtempSync(join(tmpdir(), "deadline-gh-"));
    try {
      const gh = join(bin, "gh");
      writeFileSync(gh, "#!/bin/sh\necho '{\"ok\":true}'\n");
      chmodSync(gh, 0o755);
      const result = await withDeadline(
        20_000.5,
        "read",
        (signal) =>
          withinDeadline(
            ghProcess({ PATH: `${bin}:${process.env.PATH ?? ""}` }),
            signal,
            error,
          )(["x"]),
        error,
      );
      expect(result).toEqual({ ok: true, stdout: '{"ok":true}\n', stderr: "" });
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
