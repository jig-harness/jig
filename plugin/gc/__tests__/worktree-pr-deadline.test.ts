import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../lib/test-helpers/fake-program.ts";
import { gitEnvironment } from "../git.ts";

const LOOKUPS = ["requests", "requestByNumber", "requestsForCommit"] as const;
type Lookup = (typeof LOOKUPS)[number];

const ARGUMENTS: Record<Lookup, number | string> = {
  requests: "topic",
  requestByNumber: 12,
  requestsForCommit: "a".repeat(40),
};

// Runs one lookup of worktree-git.ts in a subprocess whose `gh` is the given
// fake program (none when omitted) and returns the Outcome it printed.
function runLookup(
  lookup: Lookup,
  options: { gh?: string; ghCallTimeout: string },
): unknown {
  const root = mkdtempSync(join(tmpdir(), "gc-pr-deadline-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFakeProgram(
      join(bin, "git"),
      '#!/usr/bin/env bun\nconsole.log("https://github.com/team/repo.git");\n',
    );
    if (options.gh !== undefined) writeFakeProgram(join(bin, "gh"), options.gh);
    const module = JSON.stringify(
      resolve(import.meta.dir, "../kinds/worktree-git.ts"),
    );
    const call = `${lookup}(${JSON.stringify(root)}, "origin", ${JSON.stringify(ARGUMENTS[lookup])})`;
    const source = `import { ${lookup} } from ${module};\nconsole.log(JSON.stringify(await ${call}));`;
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
          GH_CALL_TIMEOUT: options.ghCallTimeout,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 5000,
      },
    );
    expectSpawnExit(result, 0);
    return JSON.parse(result.stdout.toString());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const HANG = "setInterval(() => {}, 1000);\n";

test.each(LOOKUPS)(
  "%s reports a lookup abandoned at GH_CALL_TIMEOUT",
  (lookup) => {
    const outcome = runLookup(lookup, {
      gh: `#!/usr/bin/env bun\n${HANG}`,
      ghCallTimeout: "1",
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: {
        code: "forge-unavailable",
        reason: expect.stringContaining("deadline"),
      },
    });
  },
  20_000,
);

test.each(LOOKUPS)(
  "%s fails as a value on an invalid GH_CALL_TIMEOUT",
  (lookup) => {
    const outcome = runLookup(lookup, { ghCallTimeout: "abc" });
    expect(outcome).toMatchObject({
      ok: false,
      failure: { code: "configuration" },
    });
  },
  20_000,
);

test("a 422 diagnostic from a call that hung is a deadline, not an absent commit", () => {
  const outcome = runLookup("requestsForCommit", {
    gh: `#!/usr/bin/env bun\nconsole.error("No commit found for SHA (HTTP 422)");\n${HANG}`,
    ghCallTimeout: "1",
  });
  expect(outcome).toMatchObject({
    ok: false,
    failure: { code: "forge-unavailable" },
  });
}, 20_000);

test.each(LOOKUPS)(
  "%s retains stderr when a lookup exceeds its deadline",
  (lookup) => {
    const diagnostic = "forge connection stalled";
    const outcome = runLookup(lookup, {
      gh: `#!/usr/bin/env bun\nconsole.error(${JSON.stringify(diagnostic)});\n${HANG}`,
      ghCallTimeout: "1",
    });
    expect(outcome).toMatchObject({
      ok: false,
      failure: {
        code: "forge-unavailable",
        reason: `Forge inventory unavailable: pull request lookup exceeded its deadline: ${diagnostic}`,
      },
    });
  },
  20_000,
);
