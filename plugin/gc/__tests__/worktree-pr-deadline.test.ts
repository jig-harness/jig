import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { gitEnvironment } from "../git.ts";

test.each(["requests", "requestByNumber", "requestsForCommit"])(
  "%s reports a lookup abandoned at GH_CALL_TIMEOUT",
  (lookup) => {
    const root = mkdtempSync(join(tmpdir(), "gc-pr-deadline-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFakeProgram(
      join(bin, "git"),
      '#!/usr/bin/env bun\nconsole.log("https://github.com/team/repo.git");\n',
    );
    writeFakeProgram(
      join(bin, "gh"),
      "#!/usr/bin/env bun\nsetInterval(() => {}, 1000);\n",
    );
    const argument =
      lookup === "requestByNumber"
        ? 12
        : lookup === "requestsForCommit"
          ? "a".repeat(40)
          : "topic";
    const source = `import { ${lookup} } from ${JSON.stringify(resolve(import.meta.dir, "../kinds/worktree-git.ts"))};
console.log(JSON.stringify(await ${lookup}(${JSON.stringify(root)}, "origin", ${JSON.stringify(argument)})));`;
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
        "-e",
        source,
      ],
      {
        cwd: root,
        env: {
          ...gitEnvironment(),
          GH_CALL_TIMEOUT: "1",
          PATH: `${bin}${delimiter}${process.env.PATH}`,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    expectSpawnExit(result, 0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      ok: false,
      failure: {
        code: "forge-unavailable",
        reason: expect.stringContaining("deadline"),
      },
    });
  },
  20_000,
);

test.each(["requests", "requestByNumber", "requestsForCommit"])(
  "%s fails as a value on an invalid GH_CALL_TIMEOUT",
  (lookup) => {
    const root = mkdtempSync(join(tmpdir(), "gc-pr-deadline-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFakeProgram(
      join(bin, "git"),
      '#!/usr/bin/env bun\nconsole.log("https://github.com/team/repo.git");\n',
    );
    const argument =
      lookup === "requestByNumber"
        ? 12
        : lookup === "requestsForCommit"
          ? "a".repeat(40)
          : "topic";
    const source = `import { ${lookup} } from ${JSON.stringify(resolve(import.meta.dir, "../kinds/worktree-git.ts"))};
console.log(JSON.stringify(await ${lookup}(${JSON.stringify(root)}, "origin", ${JSON.stringify(argument)})));`;
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
        "-e",
        source,
      ],
      {
        cwd: root,
        env: {
          ...gitEnvironment(),
          GH_CALL_TIMEOUT: "abc",
          PATH: `${bin}${delimiter}${process.env.PATH}`,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    expectSpawnExit(result, 0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      ok: false,
      failure: { code: "configuration" },
    });
  },
  20_000,
);

test("a 422 diagnostic from a call that hung is a deadline, not an absent commit", () => {
  const root = mkdtempSync(join(tmpdir(), "gc-pr-deadline-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFakeProgram(
    join(bin, "git"),
    '#!/usr/bin/env bun\nconsole.log("https://github.com/team/repo.git");\n',
  );
  writeFakeProgram(
    join(bin, "gh"),
    '#!/usr/bin/env bun\nconsole.error("No commit found for SHA (HTTP 422)");\nsetInterval(() => {}, 1000);\n',
  );
  const source = `import { requestsForCommit } from ${JSON.stringify(resolve(import.meta.dir, "../kinds/worktree-git.ts"))};
console.log(JSON.stringify(await requestsForCommit(${JSON.stringify(root)}, "origin", ${JSON.stringify("a".repeat(40))})));`;
  const result = Bun.spawnSync(
    [
      process.execPath,
      "--no-env-file",
      `--config=${resolve(import.meta.dir, "../bunfig.toml")}`,
      "-e",
      source,
    ],
    {
      cwd: root,
      env: {
        ...gitEnvironment(),
        GH_CALL_TIMEOUT: "1",
        PATH: `${bin}${delimiter}${process.env.PATH}`,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 5000,
    },
  );
  expectSpawnExit(result, 0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    ok: false,
    failure: { code: "forge-unavailable" },
  });
}, 20_000);
