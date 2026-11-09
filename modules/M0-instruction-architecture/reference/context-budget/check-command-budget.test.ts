import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";

const scratch = mkdtempSync(join(tmpdir(), "jig-command-budget-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let cases = 0;
function fixture(files: Record<string, string>) {
  const root = join(scratch, String(cases++));
  mkdirSync(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}
function run(root: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "check-discovery-budget.ts"),
      "--commands",
      root,
      ...args,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  return { ...result, output: `${result.stdout}${result.stderr}` };
}
const definition = (description: string, extra = "") =>
  `---\ndescription: ${JSON.stringify(description)}\n${extra}---\nBody.\n`;

test("commands and skills share the exact listing boundary, with command rows", () => {
  const root = fixture({
    "a.md": definition("123"),
    "nested/b.md": definition("45"),
  });
  // a: 1 + 4 + 3; nested:b: 8 + 4 + 2; one newline = 23.
  const at = run(root, "--listing", "23");
  expectSpawnExit(at, 0);
  expect(at.output).toContain("skill listing 23 / 23");
  expect(at.output).toContain("command a:");
  expect(at.output).toContain("command nested:b:");
  expectSpawnExit(run(root, "--listing", "22"), 1);
  const skills = fixture({ "s/SKILL.md": definition("D") });
  expectSpawnExit(run(root, "--skills", skills, "--listing", "23"), 1);
});

test("disabled commands have no listing cost but retain their per-entry cap", () => {
  const root = fixture({
    "a.md": definition("x", "disable-model-invocation: true\n"),
  });
  const result = run(root, "--listing", "1");
  expectSpawnExit(result, 0);
  expect(result.output).toContain("skill listing 0 / 1");
  const over = fixture({
    "a.md": definition("xxxx", "disable-model-invocation: true\n"),
  });
  expectSpawnExit(run(over, "--hard", "3"), 1);
});

test("commands without descriptions use the first nonblank body line", () => {
  const root = fixture({
    "a.md": "\n## Run it\nLater text",
    "b.md": "---\nallowed-tools: Read\n---\n\n# Do it\n",
  });
  const result = run(root);
  expectSpawnExit(result, 0);
  expect(result.output).toContain("skill listing 22 / 8000");
});

test.each(["", "\n", "# Metadata\n"])(
  "empty YAML frontmatter uses the body fallback: %j",
  (yaml) => {
    const root = fixture({ "a.md": `---\n${yaml}---\n# Run it\n` });
    const result = run(root);
    expectSpawnExit(result, 0);
    expect(result.output).toContain("skill listing 11 / 8000");
  },
);

test("fallback descriptions truncate at 100 UTF-16 units", () => {
  const root = fixture({ "a.md": `# ${"😀".repeat(51)}\n` });
  const result = run(root);
  expectSpawnExit(result, 0);
  expect(result.output).toContain("skill listing 105 / 8000");
});

test("skills shadow commands by directory and frontmatter names", () => {
  const root = fixture({
    "directory.md": definition("Hidden"),
    "alias.md": definition("Hidden"),
    "visible.md": definition("D"),
  });
  const skills = fixture({
    "directory/SKILL.md": definition("D", "name: alias\n"),
  });
  const result = run(root, "--bare-skills", skills);
  expectSpawnExit(result, 0);
  expect(result.output).toContain("skill listing 23 / 8000");
  expect(result.output).not.toContain("command directory:");
  expect(result.output).not.toContain("command alias:");
});

test("shadowed command aliases do not consume an unshadowed file's measurement", () => {
  const root = fixture({ "b.md": definition("D") });
  symlinkSync(join(root, "b.md"), join(root, "a.md"));
  const skills = fixture({ "a/SKILL.md": definition("D") });
  const result = run(root, "--bare-skills", skills);
  expectSpawnExit(result, 0);
  expect(result.output).toContain("command b:");
  expect(result.output).not.toContain("command a:");
});

test("a shadowed dangling command is omitted before its definition is read", () => {
  const root = fixture({ "b.md": definition("D") });
  symlinkSync(join(root, "absent"), join(root, "a.md"));
  const skills = fixture({ "a/SKILL.md": definition("D") });
  const result = run(root, "--bare-skills", skills);
  expectSpawnExit(result, 0);
  expect(result.output).toContain("command b:");
  expect(result.output).not.toContain("a.md: unreadable");
});

test("a plugin skill shadows only its namespaced command name", () => {
  const root = fixture({
    "p/a.md": definition("Hidden"),
    "a.md": definition("D"),
  });
  const skills = fixture({ "a/SKILL.md": definition("D") });
  const result = run(root, "--skills", skills, "--namespace", "p");
  expectSpawnExit(result, 0);
  expect(result.output).toContain("skill listing 15 / 8000");
  expect(result.output).toContain("command a:");
  expect(result.output).not.toContain("command p:a:");
});

test("commands count when_to_use toward the combined cap", () => {
  const root = fixture({ "a.md": definition("abc", "when_to_use: def\n") });
  expectSpawnExit(run(root, "--combined", "8"), 1);
});

test("malformed command metadata fails instead of under-counting", () => {
  const root = fixture({ "a.md": "---\ndescription: [invalid]\n---\nBody\n" });
  expectSpawnExit(run(root), 1);
});

test("empty commands directories add no listing cost", () => {
  const result = run(fixture({}));
  expectSpawnExit(result, 0);
  expect(result.output).toContain("skill listing 0 / 8000");
});

test.skipIf(
  skipsOnWindows(
    "file-system",
    "symbolic links and devices need POSIX fixture support",
  ),
)(
  "command links deduplicate, nested directory links work, and unreadable files fail",
  () => {
    expect.hasAssertions();
    const root = fixture({ "a.md": definition("D") });
    symlinkSync(join(root, "a.md"), join(root, "alias.md"));
    const nested = fixture({ "b.md": definition("D") });
    symlinkSync(nested, join(root, "nested"));
    const result = run(root);
    expectSpawnExit(result, 0);
    expect(result.output).toContain("2 command(s)");
    expect(result.output).toContain("command nested:b:");
    symlinkSync(join(root, "absent"), join(root, "broken.md"));
    const broken = run(root);
    expectSpawnExit(broken, 1);
    expect(broken.output).toContain(
      "broken.md: unreadable (a link to nothing)",
    );
    symlinkSync("/dev/zero", join(root, "device.md"));
    const device = run(root);
    expectSpawnExit(device, 1);
    expect(device.output).toContain(
      "device.md: unreadable (not a regular file)",
    );
  },
);
