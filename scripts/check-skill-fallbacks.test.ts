import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";

const script = join(import.meta.dir, "check-skill-fallbacks.ts");
const scratch = mkdtempSync(join(tmpdir(), "jig-skill-fallbacks-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let roots = 0;
/** A repository root outside git, with the given files. */
function repo(files: Record<string, string>): string {
  const root = join(scratch, `case-${roots++}`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  return root;
}
const skill = {
  ".claude/skills/followup/SKILL.md": "---\nname: followup\n---\n",
};

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

test("an instruction file that invokes a skill with no fallback fails", () => {
  const result = run(
    repo({ ...skill, "plugin/AGENTS.md": "After the merge, run /followup.\n" }),
  );
  expectSpawnExit(result, 1);
  expect(result.output).toContain("AGENTS.md:1:");
});

test("a linked SKILL.md, a plugin command or a fixture passes", () => {
  const root = repo({
    ...skill,
    "AGENTS.md":
      "Run [`/followup`](.claude/skills/followup/SKILL.md), then /jig:followup.\n",
    "CONTRIBUTING.md": "Nothing to run.\n",
    "x/fixtures/AGENTS.md": "Run /followup.\n",
  });
  expectSpawnExit(run(root), 0);
});

test("the skills themselves and CONTRIBUTING.md are checked", () => {
  for (const [name, text] of [
    ["CONTRIBUTING.md", "Run /followup.\n"],
    [
      ".claude/skills/other/SKILL.md",
      "---\nname: other\n---\nRun /followup.\n",
    ],
  ] as const) {
    const result = run(
      repo({ ...skill, "AGENTS.md": "Rules.\n", [name]: text }),
    );
    expectSpawnExit(result, 1, name);
  }
});

test("a repository with no skills of its own has nothing to check", () => {
  const result = run(repo({ "AGENTS.md": "Run /followup.\n" }));
  expectSpawnExit(result, 0);
  expect(result.output).toContain("nothing to check");
});
