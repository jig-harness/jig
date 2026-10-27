/**
 * The evidence record runs from the plugin as the release channels ship it:
 * copied outside this repository with no `node_modules` above it, invoked
 * from a scratch consumer repository whose own configuration names the
 * store. Its behaviour is tested in `plugin/shared/__tests__/evidence.test.ts`;
 * this file proves only that it works from the copy.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../../plugin/shared/guarded-git-spawn.ts";
import { writeWorkingArtifact } from "./artifact.ts";

const root = resolve(import.meta.dirname, "../..");
const env = withoutLeakyGitEnv();
delete env.JIG_OVERLAY;
delete env.JIG_CONSUMER_ROOT;

let scratch: string;
beforeAll(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "jig-evidence-")));
  writeWorkingArtifact(root, join(scratch, "artifact"));
  renameSync(join(scratch, "artifact", "plugin"), join(scratch, "cache"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("evidence.ts runs from the plugin copy and keeps its record in the consumer's store", () => {
  const store = join(scratch, "store");
  const consumer = join(scratch, "shop");
  mkdirSync(join(consumer, ".config"), { recursive: true });
  const init = spawnSync("git", ["init", "-q", consumer], { env });
  expectSpawnExit({ ...init, exitCode: init.status }, 0);
  writeFileSync(
    join(consumer, ".config", "jig.yaml"),
    `verify:\n  store: ${JSON.stringify(store)}\n  output_lines: 5\n`,
  );
  const evidence = join(scratch, "cache", "shared", "evidence.ts");
  const command = [process.execPath, "-e", "console.log('checked')"];
  const ran = spawnSync(
    process.execPath,
    [evidence, "run", "--json", "--name", "check", "--", ...command],
    { cwd: consumer, env },
  );
  expectSpawnExit({ ...ran, exitCode: ran.status }, 0);
  const record = JSON.parse(ran.stdout) as {
    tree: string;
    outcome: string;
    output: { head: string[] };
  };
  expect([record.outcome, record.output.head]).toEqual(["pass", ["checked"]]);
  const listed = spawnSync(process.execPath, [evidence, "list"], {
    cwd: consumer,
    env,
  });
  expectSpawnExit({ ...listed, exitCode: listed.status }, 0);
  expect(listed.stdout).toContain(
    `EVIDENCE  tree ${record.tree.slice(0, 7)}  check`,
  );
  expect(listed.stdout).toContain(join(store, "shop", record.tree));
});
