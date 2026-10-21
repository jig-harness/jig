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
  test("hands each request a whole number of milliseconds", async () => {
    const timeouts: number[] = [];
    await withDeadline(
      40.5,
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
        5_000.5,
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
