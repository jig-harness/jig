import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";

const script = join(import.meta.dir, "check-context-budget.ts");
const scratch = mkdtempSync(join(tmpdir(), "jig-context-budget-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let roots = 0;
/** A repository root outside git, with the plugin's skills and agents folders. */
function repo(pluginSkills: Record<string, string>): string {
  const root = join(scratch, `case-${roots++}`);
  mkdirSync(join(root, "plugin/agents"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), "# Agent instructions\n");
  for (const [name, description] of Object.entries(pluginSkills))
    skill(join(root, "plugin/skills"), name, description);
  return root;
}

function skill(dir: string, name: string, content: string) {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(
    join(dir, name, "SKILL.md"),
    content.startsWith("---")
      ? content
      : `---\nname: ${name}\ndescription: ${JSON.stringify(content)}\n---\nBody.\n`,
  );
}

// Eight skills of about 500 listed characters each: one folder of them fits
// the 8,000-character listing, two do not.
function eight(prefix: string): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`${prefix}${i}`, "a".repeat(495)]),
  );
}

function run(root: string) {
  const result = Bun.spawnSync([process.execPath, script, root], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    output: `${result.stdout}${result.stderr}`,
  };
}

test("no repository skills folder measures the plugin alone", () => {
  expectSpawnExit(run(repo(eight("p"))), 0);
});

test("repository skills are charged by their bare name, not the plugin's", () => {
  // Filled to exactly the 8,000-character listing with the repository
  // skills' bare names; with "jig:" before each of the eight it would not fit.
  const root = repo(eight("p"));
  const own = { ...eight("own") };
  own.own7 = "a".repeat(416);
  for (const [name, description] of Object.entries(own))
    skill(join(root, ".claude/skills"), name, description);
  const result = run(root);
  expectSpawnExit(result, 0);
  expect(result.output).toContain("skill listing 8000 / 8000");
});

// Creating a symbolic link on Windows needs Developer Mode or elevation,
// which contributors are not required to have.
test.skipIf(process.platform === "win32")(
  "a broken link where the repository skills would be fails the gate",
  () => {
    const root = repo({ p0: "A plugin skill." });
    mkdirSync(join(root, ".claude"));
    symlinkSync(join(root, "missing"), join(root, ".claude/skills"));
    expect(run(root).exitCode).not.toBe(0);
  },
);

test("a malformed repository skill fails the gate", () => {
  const root = repo({ p0: "A plugin skill." });
  skill(join(root, ".claude/skills"), "bad", "---\nname: bad\n---\n");
  expectSpawnExit(run(root), 1);
});

test("plugin and repository skills share one session listing", () => {
  const root = repo(eight("p"));
  for (const [name, description] of Object.entries(eight("own")))
    skill(join(root, ".claude/skills"), name, description);
  const result = run(root);
  expectSpawnExit(result, 1);
  expect(result.output).toContain("skill listing is");
});

test("a repository skill over the soft description target fails", () => {
  const root = repo({ p0: "A plugin skill." });
  skill(join(root, ".claude/skills"), "long", "a".repeat(600));
  expectSpawnExit(run(root), 1);
});
