import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enumerateThreads } from "../scripts/enumerate-threads.ts";
import type { run } from "../../../shared/proc.ts";

test("enumeration does not label or publish a failed producer's partial stream", async () => {
  let calls = 0;
  const execute: typeof run = async () => {
    calls++;
    return {
      code: 7,
      stdout: "partial",
      stderr: "failed",
      timedOut: false,
      bufferExceeded: false,
      spawnFailed: false,
      stderrTail: "",
    };
  };
  expect(await enumerateThreads(["123"], "/unused", execute)).toEqual({
    code: 7,
    stdout: "",
  });
  expect(calls).toBe(1);
});

test("enumeration feeds literal NDJSON to the labeler and propagates its failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-enumerate-"));
  try {
    mkdirSync(join(dir, "drive-pr"));
    let calls = 0;
    const stream = '{"body":"`code` $(literal) $HOME"}\n';
    const execute: typeof run = async (argv, options) => {
      calls++;
      if (calls === 1)
        return {
          code: 0,
          stdout: stream,
          stderr: "",
          timedOut: false,
          bufferExceeded: false,
          spawnFailed: false,
          stderrTail: "",
        };
      expect(argv).toContain(join(dir, "drive-pr/scripts/self-inflicted.ts"));
      expect(options?.stdin).toBe(stream);
      return {
        code: 1,
        stdout: "partial label",
        stderr: "failed",
        timedOut: false,
        bufferExceeded: false,
        spawnFailed: false,
        stderrTail: "",
      };
    };
    expect(
      await enumerateThreads(
        ["123", "--bots-only"],
        join(dir, "drive-pr"),
        execute,
      ),
    ).toEqual({ code: 1, stdout: "" });
    expect(calls).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
