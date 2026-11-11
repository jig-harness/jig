import { expect, test } from "bun:test";
import {
  budget,
  COMMAND_TIMEOUT_MS,
  localRunner,
  runResult,
  withLimit,
} from "../orca-workspace/runner.ts";

const timedOut = (): Error =>
  Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" });

test("commands run with untranslated messages", () => {
  const ran = localRunner([
    "/bin/sh",
    "-c",
    'printf "%s|%s" "$LC_ALL" "$LANGUAGE"',
  ]);
  expect(ran.status).toBe(0);
  expect(ran.stdout).toBe("C|");
});

test("a child that reached its deadline reads as killed, even when it reports exit 0", () => {
  // Bun's spawnSync returns this when the child exits as its deadline fires:
  // exit 0 together with ETIMEDOUT, and output that may be cut short.
  expect(
    runResult({ status: 0, stdout: "", stderr: "", error: timedOut() }),
  ).toEqual({
    status: -1,
    stdout: "",
    stderr: "spawn error: spawnSync git ETIMEDOUT",
  });
  expect(
    runResult({ status: null, stdout: "", stderr: "", error: timedOut() })
      .status,
  ).toBe(-1);
  expect(
    runResult({ status: 3, stdout: "out", stderr: "err" }),
  ).toEqual({ status: 3, stdout: "out", stderr: "err" });
});

test("a limited run cuts every call and pause to the time left, then stops", () => {
  let now = 0;
  const timeouts: (number | undefined)[] = [];
  const slept: number[] = [];
  const ctx = withLimit(
    {
      run: (_argv, options) => {
        timeouts.push(options?.timeoutMs);
        return { status: 0, stdout: "", stderr: "" };
      },
      log: () => undefined,
      sleep: (ms) => slept.push(ms),
      stateDir: "/nonexistent",
    },
    300_000,
    () => now,
  );
  ctx.run(["git", "status"]);
  now = 250_000;
  ctx.run(["git", "fetch"], { timeoutMs: 120_000 });
  ctx.sleep(90_000);
  expect(budget(ctx, 900_000)).toBe(50_000);
  expect(timeouts).toEqual([COMMAND_TIMEOUT_MS, 50_000]);
  expect(slept).toEqual([50_000]);
  now = 300_000;
  expect(() => ctx.run(["git", "status"])).toThrow("reached its limit");
  expect(() => ctx.sleep(1)).toThrow("reached its limit");
  expect(timeouts).toHaveLength(2);
});
