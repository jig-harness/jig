/**
 * The docs skill runs from a plugin copy the way the release channels ship
 * it (no tests, no `node_modules`, outside this repository): its one pass and
 * each gate it holds, against a scratch consumer repository's docs tree, its
 * schema and its configuration.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../plugin/shared/guarded-git-spawn.ts";
import { writeWorkingArtifact } from "./artifact.ts";

const root = resolve(import.meta.dirname, "../..");
const env: Record<string, string> = {};
for (const [key, value] of Object.entries(process.env))
  if (
    value !== undefined &&
    !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()) &&
    !["JIG_OVERLAY", "JIG_CONSUMER_ROOT", "LAST_UPDATED_TODAY"].includes(key)
  )
    env[key] = value;
Object.assign(env, {
  GIT_AUTHOR_NAME: "Alex Author",
  GIT_AUTHOR_EMAIL: "alex@example.com",
  GIT_COMMITTER_NAME: "Alex Author",
  GIT_COMMITTER_EMAIL: "alex@example.com",
});

let scratch: string;
let skill: string;
beforeAll(() => {
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "jig-docs-")));
  writeWorkingArtifact(root, join(scratch, "artifact"));
  renameSync(join(scratch, "artifact", "plugin"), join(scratch, "cache"));
  skill = join(scratch, "cache", "skills", "docs");
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

function run(cwd: string, program: string, args: string[]) {
  const result = spawnSync(program, args, { cwd, env, encoding: "utf8" });
  return { ...result, exitCode: result.status };
}

const page = (status: string) =>
  `---\ntitle: Page\ntype: guide\nstatus: ${status}\nlifecycle: permanent\nlast_updated: 2026-10-01\nowner: engineering\ntags: [backend]\n---\n\n# Page\n`;

test("the copy leaves the skill's tests out and keeps its gates", () => {
  expect(() => readFileSync(join(skill, "__tests__", "helpers.ts"))).toThrow();
  expect(
    readFileSync(join(skill, "scripts", "lib", "docs.ts"), "utf8"),
  ).toContain("export function readFrontmatter");
});

test("the one pass and a gate run from the copy against the consumer's tree", () => {
  const consumer = join(scratch, "consumer");
  mkdirSync(consumer);
  expectSpawnExit(run(consumer, "git", ["init", "-q", "-b", "main"]), 0);
  write(consumer, ".config/jig.yaml", "docs:\n  root: handbook\n");
  write(
    consumer,
    "handbook/schema/frontmatter-schema.yaml",
    readFileSync(
      join(
        root,
        "plugin/skills/docs/__tests__/fixtures/frontmatter-check/schema.yaml",
      ),
      "utf8",
    ),
  );
  write(consumer, "handbook/good.md", page("active"));
  write(consumer, "handbook/bad.md", page("completed"));
  expectSpawnExit(run(consumer, "git", ["add", "-A"]), 0);
  expectSpawnExit(run(consumer, "git", ["commit", "-qm", "base"]), 0);

  const pass = run(consumer, process.execPath, [
    join(skill, "scripts", "docs.ts"),
    "--json",
  ]);
  expectSpawnExit(pass, 1);
  const report = JSON.parse(pass.stdout) as {
    root: string;
    frontmatterSchema: string;
    findings: { file: string; check: string }[];
  };
  expect(report.root).toBe("handbook");
  expect(report.frontmatterSchema).toBe(
    "handbook/schema/frontmatter-schema.yaml",
  );
  expect(report.findings).toEqual([
    expect.objectContaining({ file: "handbook/bad.md", check: "frontmatter" }),
  ]);

  // The gate on its own, as a hook calls it: its schema is read with the
  // copy's vendored YAML parser.
  const gate = spawnSync(
    process.execPath,
    [
      join(skill, "scripts", "frontmatter-check", "frontmatter-check.ts"),
      "handbook/good.md",
    ],
    {
      cwd: consumer,
      env: { ...env, SCHEMA: "handbook/schema/frontmatter-schema.yaml" },
      encoding: "utf8",
    },
  );
  expectSpawnExit({ ...gate, exitCode: gate.status }, 0);
  expect(gate.stdout).toContain("OK — frontmatter valid");
});
