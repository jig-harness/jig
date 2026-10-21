import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

const entry = resolve(import.meta.dir, "../command.ts");

test("an explicit diagnostic status saves output without accepting operational failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-command-diagnostics-"));
  const output = join(dir, "report.json");
  try {
    for (const code of [1, 2]) {
      writeFileSync(output, "held");
      const result = Bun.spawnSync(
        [
          process.execPath,
          entry,
          "--stdout-file",
          output,
          "--stdout-exit-code",
          "1",
          "--",
          "bun",
          "-e",
          `console.log(JSON.stringify({findings:1}));process.exitCode=${code}`,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expectSpawnExit(result, code);
      expect(readFileSync(output, "utf8")).toBe(
        code === 1 ? '{"findings":1}\n' : "held",
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
