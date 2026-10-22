/** The resource collector runs from the same artifact the channels install. */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { gitEnvironment } from "../../plugin/gc/git.ts";
import { writeWorkingArtifact } from "./artifact.ts";

test("gc reads a consumer declaration and writes its receipt from the shipped artifact", () => {
  const root = mkdtempSync(join(tmpdir(), "gc-artifact-"));
  writeWorkingArtifact(
    resolve(import.meta.dir, "../.."),
    join(root, "artifact"),
  );
  const home = join(root, "home");
  const consumer = join(root, "consumer");
  mkdirSync(home);
  mkdirSync(join(consumer, ".config"), { recursive: true });
  writeFileSync(
    join(consumer, ".config", "jig.yaml"),
    "gc: {kinds: [scratch], scratch_prefixes: []}\n",
  );
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(root, "artifact", "plugin", "jig.ts"),
      "gc",
      "--repo",
      consumer,
      "--json",
    ],
    {
      cwd: consumer,
      env: {
        ...gitEnvironment(),
        HOME: home,
        USERPROFILE: home,
        JIG_HOME: join(home, ".jig"),
        JIG_USER_LAYER: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30000,
    },
  );
  expectSpawnExit(result, 0);
  const receipt = JSON.parse(result.stdout.toString());
  expect(receipt.kinds[0].name).toBe("scratch");
  expect(
    existsSync(
      join(
        home,
        ".local",
        "state",
        "jig",
        "gc",
        receipt.startedAt.slice(0, 10),
        `${receipt.runId}.json`,
      ),
    ),
  ).toBe(true);
});
