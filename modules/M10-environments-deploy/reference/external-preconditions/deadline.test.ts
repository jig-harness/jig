import { describe, expect, test } from "bun:test";
import {
  GH_REQUEST_MS,
  remainingMs,
  withDeadline,
  withinDeadline,
} from "./deadline.ts";

const error = (message: string) => new Error(message);
const ok = { ok: true, stdout: "{}", stderr: "" };

describe("withinDeadline", () => {
  test("bounds each request by the operation's remaining budget", async () => {
    const timeouts: number[] = [];
    await withDeadline(
      40,
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
        Bun.sleepSync(20);
        gh(["second"]);
      },
      error,
    ).catch(() => undefined);
    expect(timeouts[0]).toBeLessThanOrEqual(40);
    expect(timeouts[1]).toBeLessThanOrEqual(20);
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
          gh(["first"]);
          Bun.sleepSync(30);
          gh(["second"]);
        },
        error,
      ),
    ).rejects.toThrow("second not requested");
    expect(calls).toEqual([["first"]]);
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
});
