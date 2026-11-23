/**
 * A harness that does not fill `${CLAUDE_SKILL_DIR}` leaves the agent to put
 * the installed skill's absolute directory in its place. The commands must
 * then resolve and run from the plugin copy, with the variable unset.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../plugin/shared/guarded-git-spawn.ts";
import { writeWorkingArtifact } from "./artifact.ts";

const root = resolve(import.meta.dirname, "../..");
const variable = `$${"{CLAUDE_SKILL_DIR}"}`;
const env: Record<string, string | undefined> = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()),
  ),
);
for (const name of ["JIG_OVERLAY", "JIG_CONSUMER_ROOT", "CLAUDE_SKILL_DIR"])
  delete env[name];

let scratch: string;
let cache: string;
beforeAll(() => {
  scratch = fs.realpathSync.native(
    fs.mkdtempSync(join(tmpdir(), "jig-skill-dir-")),
  );
  const home = join(scratch, "home");
  fs.mkdirSync(home);
  Object.assign(env, { HOME: home, USERPROFILE: home });
  writeWorkingArtifact(root, join(scratch, "artifact"));
  fs.renameSync(join(scratch, "artifact", "plugin"), join(scratch, "cache"));
  cache = join(scratch, "cache", "skills");
});
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

test("every path a skill writes under its directory exists in the plugin copy", () => {
  const missing: string[] = [];
  for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(cache, entry.name);
    const text = fs.readFileSync(join(dir, "SKILL.md"), "utf8");
    for (const match of text.matchAll(
      /\$\{CLAUDE_SKILL_DIR\}((?:\/[\w.-]+)+)(?=$|["'`\s),;:])/gm,
    ))
      if (!fs.existsSync(join(dir, `.${match[1]}`)))
        missing.push(`${entry.name}: ${match[0]}`);
  }
  expect(missing).toEqual([]);
});

test("a skill command runs from the plugin copy once its directory is filled in by hand", () => {
  const dir = join(cache, "code-stats");
  const line = fs
    .readFileSync(join(dir, "SKILL.md"), "utf8")
    .split("\n")
    .find((l) =>
      l.startsWith(`bun "${variable}/scripts/code-stats.ts" --json`),
    );
  expect(line).toBeDefined();
  const consumer = join(scratch, "consumer");
  fs.mkdirSync(consumer);
  fs.writeFileSync(join(consumer, "README.md"), "# Shop\n");
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
  ]) {
    const git = spawnSync("git", ["-C", consumer, ...args], { env });
    expectSpawnExit({ ...git, exitCode: git.status }, 0);
  }
  const [, script, rest = ""] = (line as string)
    .replace(variable, dir)
    .replace(/\s+#.*$/, "")
    .match(/^bun "([^"]+)"(.*)$/) as string[];
  const run = spawnSync(
    process.execPath,
    [script as string, ...rest.trim().split(/\s+/)],
    { cwd: consumer, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...run, exitCode: run.status }, 0);
  expect(() => JSON.parse(run.stdout)).not.toThrow();
});
