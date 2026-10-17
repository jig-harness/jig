import { test, expect } from "bun:test";
import { join } from "node:path";
const cases: [number, string, string[]][] = [
  [0, "clean code passes", ["$fix/clean/good.ts"]],
  [1, "deny-on-match (console.log) fails critical", ["$fix/bad/logging.ts"]],
  [0, "excluded test file is not checked", ["$fix/bad/logging.test.ts"]],
  [0, "require-nearby miss is a non-blocking warning", ["$fix/bad/fetch.ts"]],
  [1, "warning fails under STRICT", ["--strict", "$fix/bad/fetch.ts"]],
];
for (const [want, label, params] of cases) {
  test(label, () => {
    let args = params.map((value) =>
      value.replace("$fix", join(import.meta.dir, "fixtures")),
    );
    const env = {
      ...process.env,
      RULES: join(import.meta.dir, "fixtures/adr-rules.yaml"),
      NEW_DOCS: "",
      STRICT: "0",
      ADR_DIR: "",
    };
    if (args[0] === "--new") {
      env.NEW_DOCS = args[1] ?? "";
      args = args.slice(2);
    }
    if (args[0] === "--strict") {
      env.STRICT = "1";
      args = args.slice(1);
    }

    const result = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, "adr-rules-check.ts"), ...args],
      { env },
    );
    expectSpawnExit(result, want);
  });
}

import { globMatches } from "./adr-rules-check";
test("exclusion globs match native Windows separators and preserve POSIX literal backslashes", () => {
  expect(
    globMatches("C:\\repo\\src\\logging.test.ts", "**/*.test.*", "win32"),
  ).toBe(true);
  expect(globMatches("/repo/src/logging.test.ts", "**/*.test.*", "linux")).toBe(
    true,
  );
  expect(
    globMatches("/repo/src\\logging.test.ts", "**/src/logging.test.*", "linux"),
  ).toBe(false);
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
test("companion window boundaries preserve negative empty neighborhoods and reject invalid configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "jig-adr-window-"));
  try {
    const file = join(root, "fetch.ts");
    writeFileSync(
      file,
      'fetch("https://example.com");\n' +
        "// filler\n".repeat(8) +
        "// timeout\n" +
        "// filler\n".repeat(10),
    );
    const run = (window: string) =>
      Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "adr-rules-check.ts"), file],
        {
          env: {
            ...process.env,
            RULES: join(import.meta.dir, "fixtures/adr-rules.yaml"),
            STRICT: "1",
            WINDOW: window,
          },
        },
      ).exitCode;
    expect(run("9")).toBe(0);
    expect(run("8")).toBe(1);
    expect(run("-10")).toBe(1);
    writeFileSync(file, 'fetch("https://example.com"); // timeout\n');
    expect(run("0")).toBe(0);
    expect(run("-1")).toBe(1);
    for (const window of ["nope", "Infinity", "1.5", "9007199254740992"])
      expect(run(window)).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
