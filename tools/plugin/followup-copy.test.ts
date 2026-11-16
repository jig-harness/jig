/**
 * The follow-up's protocol runs from the plugin as the release channels
 * ship it: copied outside this repository with no `node_modules` above it
 * (the copy `plugin.test.ts` builds, through `writeWorkingArtifact`),
 * invoked from a scratch consumer repository whose own configuration turns
 * an arm off and tightens the authority table. Its behaviour is tested in
 * `plugin/skills/followup/__tests__/`; this file proves only that it works
 * from the copy.
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
delete env.ORCA_CLI_COMMAND;
delete env.ORCA_CLI_BIN_DIR;

let scratch: string;
beforeAll(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "jig-followup-")));
  writeWorkingArtifact(root, join(scratch, "artifact"));
  renameSync(join(scratch, "artifact", "plugin"), join(scratch, "cache"));
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** A consumer repository with a started follow-up run of PR 7. */
function consumerWithRun(): string {
  const consumer = join(scratch, "shop");
  mkdirSync(join(consumer, ".config"), { recursive: true });
  const init = spawnSync("git", ["init", "-q", consumer], { env });
  expectSpawnExit({ ...init, exitCode: init.status }, 0);
  writeFileSync(
    join(consumer, ".config", "jig.yaml"),
    "followup:\n  off: [live-verification]\n  authority:\n    stop-driver: person\n",
  );
  const ledger = join(consumer, ".context", "scratch", "followup");
  mkdirSync(ledger, { recursive: true });
  const facts = {
    mode: "post-merge",
    remote: "origin",
    integrationBranch: "main",
  };
  const run = {
    schema: 1,
    pr: 7,
    facts,
    arms: { apply: [], skipped: [] },
    verdicts: {},
    marker: null,
  };
  writeFileSync(join(ledger, "pr-7.json"), JSON.stringify(run));
  writeFileSync(join(ledger, "current.json"), JSON.stringify({ pr: 7 }));
  return consumer;
}

test("followup.ts runs its protocol from the plugin copy and reads the consumer's followup section", () => {
  const consumer = consumerWithRun();
  const script = join(
    scratch,
    "cache",
    "skills",
    "followup",
    "scripts",
    "followup.ts",
  );
  const followup = (...args: string[]) => {
    const ran = spawnSync(process.execPath, [script, ...args], {
      cwd: consumer,
      env,
    });
    return { ...ran, exitCode: ran.status };
  };
  const arms = followup("arms", "--json");
  expectSpawnExit(arms, 0);
  const plan = JSON.parse(arms.stdout) as { apply: string[] };
  expect(plan.apply).not.toContain("live-verification");
  expect(plan.apply).toContain("tracker");
  expectSpawnExit(followup("settle"), 1);
  for (const arm of plan.apply)
    expectSpawnExit(
      followup("record", arm, "not-owed", "--evidence", `${arm}: checked`),
      0,
      arm,
    );
  const settled = followup("settle", "--json");
  expectSpawnExit(settled, 0);
  expect((JSON.parse(settled.stdout) as { ending: string }).ending).toBe(
    "done",
  );
  const authority = followup("authority", "--json");
  expectSpawnExit(authority, 0);
  const rows = JSON.parse(authority.stdout) as { id: string; level: string }[];
  expect(rows.find((r) => r.id === "stop-driver")?.level).toBe("person");
});
