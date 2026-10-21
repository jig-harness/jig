import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

const entry = resolve(import.meta.dir, "../command.ts");

test("an explicit diagnostic status saves output without accepting operational failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-command-diagnostics-"));
  const output = join(dir, "report.json");
  try {
    for (const code of [1, 2, 124, 127]) {
      writeFileSync(output, "held");
      const result = Bun.spawnSync(
        [
          process.execPath,
          entry,
          "--stdout-file",
          output,
          "--stdout-exit-code",
          String(code === 2 ? 1 : code),
          "--",
          "bun",
          "-e",
          `console.log(JSON.stringify({findings:1}));process.exitCode=${code}`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expectSpawnExit(result, code);
      expect(readFileSync(output, "utf8")).toBe(
        code === 2 ? "held" : '{"findings":1}\n',
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid diagnostic statuses refuse before the producer runs", () => {
  for (const value of ["-1", "256", "1.5", "one"]) {
    const result = Bun.spawnSync(
      [
        process.execPath,
        entry,
        "--stdout-exit-code",
        value,
        "--",
        "bun",
        "-e",
        "console.log('ran')",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(result, 2);
    expect(result.stdout.toString()).not.toContain("ran");
  }
});

test.each([
  {
    failure: "output cap",
    code: 1,
    args: [
      "--",
      "bun",
      "-e",
      "process.stdout.write('x'.repeat(65 * 1024 * 1024))",
    ],
  },
  {
    failure: "timeout",
    code: 124,
    args: [
      "--timeout-seconds",
      "1",
      "--",
      "bun",
      "-e",
      "console.log('partial report');setInterval(() => {}, 1000)",
    ],
  },
  {
    failure: "spawn failure",
    code: 127,
    args: ["--", "<missing-program>"],
  },
])(
  "preserves the destination on $failure despite its accepted status",
  ({ code, args }) => {
    const dir = mkdtempSync(join(tmpdir(), "jig-command-operational-failure-"));
    const output = join(dir, "report.json");
    const sentinel = "previous report";
    try {
      writeFileSync(output, sentinel);
      const result = Bun.spawnSync(
        [
          process.execPath,
          entry,
          "--stdout-file",
          output,
          "--stdout-exit-code",
          String(code),
          ...args.map((arg) =>
            arg === "<missing-program>" ? join(dir, "missing-program") : arg,
          ),
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expectSpawnExit(result, code);
      // Check size before reading, so a regression never prints the capped report.
      expect(statSync(output).size).toBe(Buffer.byteLength(sentinel));
      expect(readFileSync(output, "utf8")).toBe(sentinel);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15_000,
);
