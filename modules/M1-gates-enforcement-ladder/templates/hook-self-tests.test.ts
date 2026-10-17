// The hook self-test runner is itself an enforcement script, so it carries a
// paired self-test: each run below builds a scratch hooks directory and a PATH
// holding only the tools the runner calls, and checks the exit and that every
// test that could run did run.
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runner = join(import.meta.dir, "hook-self-tests.sh");

function tool(name: string): string {
  const path = Bun.which(name);
  if (path === null) throw new Error(`${name} is not on PATH`);
  return path;
}

type Run = { status: number; stderr: string; dir: string };

function run(
  files: Record<string, string>,
  { bun = true, mkdir = true } = {},
): Run {
  const root = mkdtempSync(join(tmpdir(), "hook-self-tests-"));
  const dir = join(root, "hooks");
  if (mkdir) mkdirSync(join(dir, "__tests__"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  const bin = join(root, "bin");
  mkdirSync(bin);
  for (const name of ["bash", "basename"]) symlinkSync(tool(name), join(bin, name));
  if (bun) symlinkSync(process.execPath, join(bin, "bun"));
  const result = Bun.spawnSync([tool("bash"), runner, dir], {
    cwd: root,
    env: { PATH: bin, HOME: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { status: result.exitCode, stderr: result.stderr.toString(), dir };
}

// A shell test that leaves a mark, so a run can show it was executed.
const marks = (name: string, status = 0) =>
  `printf ran > "\${0%/*}/${name}.ran"\nexit ${status}\n`;
const ran = (dir: string, name: string) =>
  readFileSync(join(dir, `${name}.ran`), "utf8") === "ran";

const passingTs = `import { expect, test } from "bun:test";
test("passes", () => expect(1).toBe(1));
`;

describe.skipIf(process.platform === "win32")("hook-self-tests.sh", () => {
  test("a missing directory could not be checked", () => {
    expect(run({}, { mkdir: false }).status).toBe(2);
  });

  test("a directory with no hook could not be checked", () => {
    expect(run({}).status).toBe(2);
  });

  test("every hook tested and every test passing exits 0", () => {
    const { status, dir } = run({
      "guard.sh": "",
      "guard.test.sh": marks("guard"),
    });
    expect(status).toBe(0);
    expect(ran(dir, "guard")).toBe(true);
  });

  test("a hook with no test exits 1", () => {
    const { status, stderr } = run({ "guard.sh": "" });
    expect(status).toBe(1);
    expect(stderr).toContain("has no test");
  });

  test("a failing test exits 1", () => {
    const { status, stderr } = run({
      "guard.sh": "",
      "guard.test.sh": marks("guard", 1),
    });
    expect(status).toBe(1);
    expect(stderr).toContain("FAILED");
  });

  test("a TypeScript test runs with bun", () => {
    const { status } = run({ "guard.ts": "", "guard.test.ts": passingTs });
    expect(status).toBe(0);
  });

  test("without bun, the shell tests still run and the TypeScript test could not be checked", () => {
    const { status, stderr, dir } = run(
      {
        "guard.ts": "",
        "guard.test.ts": passingTs,
        "other.sh": "",
        "other.test.sh": marks("other"),
      },
      { bun: false },
    );
    expect(status).toBe(2);
    expect(stderr).toContain("needs bun");
    expect(ran(dir, "other")).toBe(true);
  });

  test("without bun, a hook with no test still exits 1", () => {
    const { status } = run(
      { "guard.ts": "", "guard.test.ts": passingTs, "other.sh": "" },
      { bun: false },
    );
    expect(status).toBe(1);
  });

  test("without bun, a failing shell test still exits 1", () => {
    const { status } = run(
      {
        "guard.ts": "",
        "guard.test.ts": passingTs,
        "other.sh": "",
        "other.test.sh": marks("other", 1),
      },
      { bun: false },
    );
    expect(status).toBe(1);
  });
});

