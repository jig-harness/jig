import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";

const root = resolve(import.meta.dir, "..");
const gate = join(root, "scripts/check-generated-files.ts");

function run(cwd: string) {
  const result = Bun.spawnSync([process.execPath, gate], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

test("every generated file Jig declares is fresh", () => {
  const result = run(root);
  expectSpawnExit(result, 0);
  expect(result.stdout).toContain("generated-files: OK —");
});

test("a root without the catalog, or with one declaring nothing, could not be checked", () => {
  const temp = mkdtempSync(join(tmpdir(), "jig-generated-files-"));
  try {
    expectSpawnExit(run(temp), 2);
    mkdirSync(join(temp, ".config"));
    writeFileSync(
      join(temp, ".config/change-areas.yaml"),
      'areas:\n  docs:\n    title: "Docs"\n    paths: ["**/*.md"]\n',
    );
    const result = run(temp);
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain(
      "no area of the catalog declares a `generated:` entry",
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("a relative root reads the catalog under that root, once", () => {
  const temp = mkdtempSync(join(tmpdir(), "jig-generated-files-"));
  try {
    const consumer = join(temp, "consumer");
    mkdirSync(join(consumer, ".config"), { recursive: true });
    writeFileSync(join(consumer, "out.txt"), "x\n");
    writeFileSync(
      join(consumer, ".config/change-areas.yaml"),
      [
        "areas:",
        "  docs:",
        '    title: "Docs"',
        '    paths: ["out.txt"]',
        "    generated:",
        '      - outputs: ["out.txt"]',
        '        source: ["out.txt"]',
        "        command: echo regenerate",
        "        check: exit 0",
        "",
      ].join("\n"),
    );
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `const { checkGeneratedFiles } = await import(${JSON.stringify(gate)}); process.exit(await checkGeneratedFiles("consumer"));`,
      ],
      { cwd: temp, stdout: "pipe", stderr: "pipe" },
    );
    expectSpawnExit(
      {
        exitCode: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      },
      0,
    );
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
