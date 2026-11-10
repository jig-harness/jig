/** The steward CLI runs from the installed artifact and authenticates its launch. */
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeWorkingArtifact } from "../../../../tools/plugin/artifact.ts";
import { record } from "../../../dispatch/__tests__/line-fixtures.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";

test("the copied skill reads its digest, refuses a wrong token and submits once", () => {
  const scratch = realpathSync.native(
    mkdtempSync(join(tmpdir(), "jig-steward-copy-")),
  );
  try {
    const home = join(scratch, "home");
    const consumer = join(scratch, "consumer");
    mkdirSync(home);
    mkdirSync(consumer);
    writeFileSync(
      join(consumer, "bunfig.toml"),
      'preload = ["./preload.ts"]\n',
    );
    writeFileSync(
      join(consumer, "preload.ts"),
      'throw new Error("consumer preload executed");\n',
    );
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    const root = resolve(import.meta.dirname, "../../../..");
    writeWorkingArtifact(root, join(scratch, "artifact"));
    const plugin = join(scratch, "artifact", "plugin");
    const launch = record({
      action: "steward",
      pr: null,
      token: "launch-secret",
    }).record;
    const digest = {
      version: 1,
      repo: launch.repo,
      drives: [],
      needs: [],
      queue: [],
      passes: [],
      failures: [],
      load: null,
    };
    const seed = join(scratch, "seed.ts");
    writeFileSync(
      seed,
      [
        `import {writeRecord} from ${JSON.stringify(join(plugin, "dispatch/lib/launches.ts"))};`,
        `import {keepStewardRun} from ${JSON.stringify(join(plugin, "dispatch/lib/steward.ts"))};`,
        `writeRecord(${JSON.stringify(launch)});`,
        `keepStewardRun(${JSON.stringify(launch.id)}, ${JSON.stringify(digest)}, Date.now());`,
      ].join("\n"),
    );
    const run = (args: string[]) => {
      const result = spawnSync(
        process.execPath,
        [
          "--no-env-file",
          `--config=${join(plugin, "dispatch/bunfig.toml")}`,
          ...args,
        ],
        {
          cwd: consumer,
          env,
          timeout: 30_000,
        },
      );
      return { ...result, exitCode: result.status };
    };
    expectSpawnExit(run([seed]), 0);
    const cli = join(plugin, "skills/steward/scripts/steward.ts");
    const wrong = run([cli, "read", launch.id, "wrong"]);
    expectSpawnExit(wrong, 2);
    expect(wrong.stderr).toContain("token");
    const read = run([cli, "read", launch.id, launch.token]);
    expectSpawnExit(read, 0);
    expect(JSON.parse(read.stdout)).toMatchObject({
      repo: launch.repo,
      version: 1,
    });
    const proposals = join(consumer, "records.json");
    writeFileSync(proposals, "[]");
    expectSpawnExit(
      run([cli, "submit", launch.id, launch.token, "--input", proposals]),
      0,
    );
    writeFileSync(
      proposals,
      '[{"kind":"send","text":"continue","reason":"test"}]',
    );
    expectSpawnExit(
      run([cli, "submit", launch.id, launch.token, "--input", proposals]),
      2,
    );
    writeFileSync(proposals, " ".repeat(500_001));
    const oversized = run([
      cli,
      "submit",
      launch.id,
      launch.token,
      "--input",
      proposals,
    ]);
    expectSpawnExit(oversized, 2);
    expect(oversized.stderr).toContain("too large");
    expectSpawnExit(
      run([cli, "submit", launch.id, launch.token, "--input", consumer]),
      2,
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}, 60_000);
