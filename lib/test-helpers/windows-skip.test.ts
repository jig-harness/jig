import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "./expect-spawn-exit.ts";
import * as windowsSkip from "./windows-skip.ts";
import {
  byPlatform,
  exceptOnWindows,
  skipsOnWindows,
  WINDOWS_STEPS,
  type WindowsStep,
} from "./windows-skip.ts";

const root = join(import.meta.dir, "..", "..");

describe("skipsOnWindows", () => {
  test("is true on Windows only", () => {
    expect(skipsOnWindows("process-lifecycle", "reads ps")).toBe(
      process.platform === "win32",
    );
  });

  test("refuses a skip that names no piece of the plan item or gives no reason", () => {
    expect(() => skipsOnWindows("not-a-piece" as WindowsStep, "why")).toThrow(
      /names its piece of work/,
    );
    expect(() => skipsOnWindows("process-lifecycle", " ")).toThrow(
      /names its piece of work/,
    );
  });

  test.each(["constructor", "toString", "__proto__"])(
    "refuses %s, which every object inherits",
    (step) => {
      expect(() => skipsOnWindows(step as WindowsStep, "why")).toThrow(
        /names its piece of work/,
      );
    },
  );

  test("names only the pieces of Windows work", () => {
    expect(Object.keys(WINDOWS_STEPS)).toEqual([
      "process-lifecycle",
      "file-system",
      "git-bash",
      "powershell",
      "fixture-throughput",
    ]);
  });

  test("accepts the native fixture throughput work piece", () => {
    expect(
      skipsOnWindows(
        "fixture-throughput" as WindowsStep,
        "fixture exceeds its budget",
      ),
    ).toBe(process.platform === "win32");
  });
});

// Every comparison with "win32" in either order, and a `case "win32":`, in any
// quote style. What is compared does not matter: an alias of the platform is
// compared the same way.
const WIN32_COMPARISON =
  /[!=]==?\s*(["'\x60])win32\1|(["'\x60])win32\2\s*[!=]==?|\bcase\s+(["'\x60])win32\3\s*:/;

const transpiler = new Bun.Transpiler({ loader: "ts" });

/**
 * The statements of `source` that compare with "win32", which branch on the
 * platform other than through the helpers. The source is reprinted by Bun's
 * parser first, so comments and redundant parentheses around either side
 * cannot hide a comparison. A comment does not excuse one either, since text
 * cannot tell a whole-test skip from a guard.
 */
function platformBranchFaults(source: string): string[] {
  return transpiler
    .transformSync(source)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => WIN32_COMPARISON.test(line));
}

describe("platformBranchFaults", () => {
  test.each([
    ['it.skipIf(process.platform === "win32")("x", () => {});', 1],
    [
      '// Windows lacks signals\nit.skipIf(process.platform === "win32")("x", () => {});',
      1,
    ],
    ["it.skipIf(\n  process.platform === 'win32',\n)(\"x\", () => {});", 1],
    ['describe.runIf(process.platform !== "win32")("x", () => {});', 1],
    [
      '// Windows has no ps\ndescribe.runIf(process.platform !== "win32")("x", () => {});',
      1,
    ],
    ['test.skipIf("win32" === process.platform)("x", () => {});', 1],
    ['test.if(platform() !== `win32`)("x", () => {});', 1],
    [
      'const isWindows = process.platform === "win32"; // Windows\nit.skipIf(isWindows)("x", () => {});',
      1,
    ],
    [
      '// Windows has no sh\nif (process.platform !== "win32") {\n  test("x", () => {});\n}',
      1,
    ],
    [
      'test("x", () => {\n  // Windows lacks signals\n  if (process.platform === "win32") return;\n});',
      1,
    ],
    [
      'test.skipIf(")".length > 0 && process.platform === "win32")("x", () => {});',
      1,
    ],
    [
      '// Windows reports 0o666 for any writable file.\nif (process.platform !== "win32") expect(mode).toBe(0o600);',
      1,
    ],
    [
      'const shell = process.platform === "win32" ? "cmd" : "sh"; // Windows has no sh',
      1,
    ],
    ['const p = process.platform;\nif (p === "win32") return;', 1],
    ['switch (process.platform) {\n  case "win32":\n    return;\n}', 1],
    [
      'exceptOnWindows("Windows reports 0o666 for any writable file", () =>\n  expect(mode).toBe(0o600));',
      0,
    ],
    [
      'const shell = byPlatform("Windows has no sh", { windows: "cmd", posix: "sh" });\nif (ready) return;',
      0,
    ],
    [
      'function fixturePath() {\n  return byPlatform("Windows uses drive letters", { windows: "C:/tmp", posix: "/tmp" });\n}',
      0,
    ],
    [
      'it.skipIf(skipsOnWindows("file-system", "hard links"))("x", () => {});',
      0,
    ],
    ['expect(pidCheckCommand(42, host, "win32")).toBe("x");', 0],
    ['Object.defineProperty(process, "platform", { value: "win32" });', 0],
    [
      'it.skipIf(process.platform === /* Windows lacks signals */ "win32")("x", () => {});',
      1,
    ],
    ['it.skipIf(process.platform === ("win32"))("x", () => {});', 1],
    [
      'it.skipIf(/* Windows lacks signals */ "win32" /* it does */ === process.platform)("x", () => {});',
      1,
    ],
    ['it.skipIf(((process.platform)) !== ((`win32`)))("x", () => {});', 1],
    ['switch (p) {\n  case /* Windows */ ("win32"):\n    return;\n}', 1],
  ] as const)("%j has %d refused comparison(s)", (source, expected) => {
    expect(platformBranchFaults(source)).toHaveLength(expected);
  });
});

describe("exceptOnWindows and byPlatform", () => {
  const atRegistration = (branch: () => unknown) => {
    try {
      branch();
    } catch (error) {
      return String(error);
    }
    return "decided";
  };
  const checkedAtRegistration = atRegistration(() =>
    exceptOnWindows("Windows has no sh", () => undefined),
  );
  const chosenAtRegistration = atRegistration(() =>
    byPlatform("Windows has no sh", { windows: "cmd", posix: "sh" }),
  );

  test("refuse to decide outside a running test", () => {
    expect(checkedAtRegistration).toMatch(/inside a running test/);
    expect(chosenAtRegistration).toMatch(/inside a running test/);
  });

  test("refuse a branch that gives no reason", () => {
    expect(() => exceptOnWindows(" ", () => undefined)).toThrow(/says why/);
    expect(() => byPlatform(" ", { windows: "a", posix: "b" })).toThrow(
      /says why/,
    );
  });

  test("hand a test no boolean to branch on", () => {
    expect(Object.keys(windowsSkip).sort()).toEqual([
      "WINDOWS_STEPS",
      "byPlatform",
      "exceptOnWindows",
      "markRunningTests",
      "skipsOnWindows",
    ]);
  });

  test("byPlatform picks the value for this platform", () => {
    expect(
      byPlatform("Windows has no sh", { windows: "cmd", posix: "sh" }),
    ).toBe(process.platform === "win32" ? "cmd" : "sh");
  });

  test.skipIf(skipsOnWindows("git-bash", "this test runs the POSIX branch"))(
    "exceptOnWindows runs its check, synchronously, everywhere but Windows",
    () => {
      let ran = false;
      exceptOnWindows("Windows has no sh", () => {
        ran = true;
      });
      expect(ran).toBe(true);
      // The linter refuses an async check; this one gets past it as a cast.
      const later = (async () => undefined) as unknown as () => void;
      expect(() => exceptOnWindows("Windows has no sh", later)).toThrow(
        /synchronous/,
      );
    },
  );

  // On Windows exceptOnWindows's check does not run, elsewhere it may assert
  // nothing, and a test that took a value from byPlatform may have branched
  // on it: in each case the test must still assert something. The platform is faked in a child test
  // process.
  test("a test that asserts nothing on the platform it runs on fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "windows-branch-"));
    try {
      const file = join(dir, "branch.test.ts");
      writeFileSync(
        file,
        `import { expect, test } from "bun:test";
import { byPlatform, exceptOnWindows } from ${JSON.stringify(join(import.meta.dir, "windows-skip.ts"))};
const on = (value: string) => Object.defineProperty(process, "platform", { value });
test("only POSIX checks", () => {
  on("win32");
  exceptOnWindows("Windows has no sh", () => expect(1).toBe(1));
});
test("asserts on Windows too", () => {
  on("win32");
  exceptOnWindows("Windows has no sh", () => expect(1).toBe(2));
  expect(2).toBe(2);
});
test("returns on Windows before asserting", () => {
  on("win32");
  if (byPlatform("Windows lacks signals", { windows: "skip", posix: "run" }) === "skip") return;
  expect(1).toBe(1);
});
test("returns on POSIX before asserting", () => {
  on("linux");
  if (byPlatform("Windows lacks signals", { windows: "run", posix: "skip" }) === "skip") return;
  expect(1).toBe(1);
});
test("only an empty check on POSIX", () => {
  on("linux");
  exceptOnWindows("Windows has no sh", () => {});
});
test("asserts with the value", () => {
  on("win32");
  expect(byPlatform("Windows has no sh", { windows: "cmd", posix: "sh" })).toBe("cmd");
});
`,
      );
      const run = Bun.spawnSync(
        [
          process.execPath,
          "test",
          "--preload",
          join(root, "lib", "test-env-preload.ts"),
          file,
        ],
        { cwd: dir, stdout: "pipe", stderr: "pipe" },
      );
      expectSpawnExit(run, 1, "bun test");
      const output = run.stderr.toString();
      expect(output).toMatch(/\(fail\) only POSIX checks/);
      expect(output).toMatch(/\(fail\) returns on Windows before asserting/);
      expect(output).toMatch(/\(fail\) returns on POSIX before asserting/);
      expect(output).toMatch(/\(fail\) only an empty check on POSIX/);
      expect(output).toMatch(/expected at least one assertion/);
      expect(output).not.toMatch(/\(fail\) asserts on Windows too/);
      expect(output).not.toMatch(/\(fail\) asserts with the value/);
      expect(output).toMatch(/\b2 pass\b/);
      expect(output).toMatch(/\b4 fail\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A branch on Windows that names no work is a skip nobody removes. The suites
// that run on Windows skip a whole test through skipsOnWindows and branch
// inside a test through exceptOnWindows or byPlatform, which say why.
describe("the drive-pr and do-item suites branch on Windows only through the helpers", () => {
  const dirs = [
    "plugin/skills/drive-pr/__tests__",
    "plugin/skills/do-item/__tests__",
  ];
  const files = dirs.flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => join(dir, name)),
  );

  test.each(files)("%s", (file) => {
    const source = readFileSync(join(root, file), "utf8");
    expect(
      platformBranchFaults(source).map((line) => `${file}: ${line}`),
    ).toEqual([]);
  });
});
