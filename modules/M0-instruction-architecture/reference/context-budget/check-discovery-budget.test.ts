import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const script = join(import.meta.dir, "check-discovery-budget.ts");
const fixtures = join(import.meta.dir, "fixtures");
const scratch = mkdtempSync(join(tmpdir(), "jig-discovery-budget-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let dirs = 0;
function dir(): string {
  const path = join(scratch, `case-${dirs++}`);
  mkdirSync(path);
  return path;
}

function skill(root: string, name: string, description: string, extra = "") {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n${extra}---\nBody.\n`,
  );
}

function run(args: string[]) {
  const result = Bun.spawnSync([process.execPath, script, ...args], {
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
const skills = (root: string, ...more: string[]) =>
  run(["--skills", root, ...more]);

// Eight entries: "- " + name + ": " + description each, seven newlines between
// them, 8,000 in all. Each description passes its own cap; only the listing
// can fail.
function boundary(extra = 0, metadata = ""): string {
  const root = dir();
  for (let i = 0; i < 8; i++)
    skill(root, `s${i}`, "a".repeat(i === 7 ? 987 + extra : 994), metadata);
  return root;
}

test("the committed fixtures fit every budget", () => {
  const result = run([
    "--skills",
    join(fixtures, "skills"),
    "--agents",
    join(fixtures, "agents"),
  ]);
  expectSpawnExit(result, 0);
  expect(result.output).toContain("2 skill(s), 1 listed");
  expect(result.output).toContain("1 agent(s)");
});

test("a description at the hard limit passes and one character more fails", () => {
  const at = dir();
  skill(at, "at", "x".repeat(1024));
  expectSpawnExit(skills(at), 0);
  const over = dir();
  skill(over, "over", "x".repeat(1025));
  const result = skills(over);
  expectSpawnExit(result, 1);
  expect(result.output).toContain("description 1025 chars, over the 1024");
});

test("a folded description is measured by its value, not its lines", () => {
  const root = dir();
  mkdirSync(join(root, "folded"));
  const lines = Array.from({ length: 12 }, () => `  ${"y".repeat(100)}`);
  writeFileSync(
    join(root, "folded", "SKILL.md"),
    `---\nname: folded\ndescription: >-\n${lines.join("\n")}\n---\nBody.\n`,
  );
  const result = skills(root);
  expectSpawnExit(result, 1);
  expect(result.output).toContain("description 1211 chars");
});

test("the description cap counts code points, the listing UTF-16 units", () => {
  const capped = dir();
  skill(capped, "astral", `${"x".repeat(1023)}😀`);
  expectSpawnExit(skills(capped), 0);
  const listed = boundary();
  skill(listed, "s7", `${"a".repeat(986)}😀`);
  const result = skills(listed);
  expectSpawnExit(result, 1);
  expect(result.output).toContain("skill listing is 1 chars over 8000");
});

test("the soft target is reported, and fails only with --fail-soft", () => {
  const root = dir();
  skill(root, "broad", "x".repeat(600));
  const noted = skills(root);
  expectSpawnExit(noted, 0);
  expect(noted.output).toContain("over the 512-char soft target");
  expectSpawnExit(skills(root, "--fail-soft"), 1);
  expectSpawnExit(skills(root, "--soft", "600", "--fail-soft"), 0);
});

test("the listing passes at its budget and fails one character over", () => {
  const at = skills(boundary());
  expectSpawnExit(at, 0);
  expect(at.output).toContain("skill listing 8000 / 8000");
  const over = skills(boundary(1));
  expectSpawnExit(over, 1);
  expect(over.output).toContain("skill listing is 1 chars over 8000");
  expectSpawnExit(skills(boundary(1), "--listing", "8001"), 0);
});

test("path-scoped skills count toward the listing", () => {
  const result = skills(boundary(1, 'paths: ["services/**"]\n'));
  expectSpawnExit(result, 1);
  expect(result.output).toContain("8 path-scoped");
  expect(result.output).toContain("skill listing is 1 chars over 8000");
});

test("an explicit-only skill leaves the listing but keeps its own cap", () => {
  const root = boundary(1);
  skill(root, "s7", "a".repeat(988), "disable-model-invocation: true\n");
  expectSpawnExit(skills(root), 0);
  skill(root, "s7", "a".repeat(1025), "disable-model-invocation: true\n");
  expectSpawnExit(skills(root), 1);
});

test("when_to_use counts toward the listing and the combined cap", () => {
  const root = boundary();
  skill(root, "s7", "a".repeat(987), "when_to_use: x\n");
  const listing = skills(root);
  expectSpawnExit(listing, 1);
  expect(listing.output).toContain("skill listing is 4 chars over");
  const combined = dir();
  skill(combined, "c", "a".repeat(800), `when_to_use: ${"b".repeat(734)}\n`);
  const result = skills(combined);
  expectSpawnExit(result, 1);
  expect(result.output).toContain("description + when_to_use 1537 chars");
});

test("the plugin namespace is part of each listed name", () => {
  const root = boundary();
  const result = skills(root, "--namespace", "p");
  expectSpawnExit(result, 1);
  expect(result.output).toContain("skill listing is 16 chars over");
});

test("bare skills share the listing and take no namespace", () => {
  // At exactly 8,000 unprefixed, so a namespace on these would fail.
  const atBudget = run(["--bare-skills", boundary(), "--namespace", "p"]);
  expectSpawnExit(atBudget, 0);
  const plugin = dir();
  skill(plugin, "x", "D.");
  const shared = run(["--skills", plugin, "--bare-skills", boundary()]);
  expectSpawnExit(shared, 1);
  expect(shared.output).toContain("skill listing is");
});

test("a bare skill may share a name with a namespaced one", () => {
  const plugin = dir();
  const own = dir();
  skill(plugin, "same", "D.");
  skill(own, "same", "D.");
  const result = run([
    "--skills",
    plugin,
    "--bare-skills",
    own,
    "--namespace",
    "p",
  ]);
  expectSpawnExit(result, 0);
  expectSpawnExit(run(["--skills", plugin, "--bare-skills", own]), 1);
});

test.each([
  ["no frontmatter", "# A skill\n\nBody.\n"],
  ["no description", "---\nname: bad\n---\n"],
  [
    "a non-boolean switch",
    '---\ndescription: D.\ndisable-model-invocation: "false"\n---\n',
  ],
  ["a list for when_to_use", "---\ndescription: D.\nwhen_to_use: [x]\n---\n"],
  ["empty paths", "---\ndescription: D.\npaths: []\n---\n"],
  ["a list for a name", "---\nname: []\ndescription: D.\n---\n"],
])("unusable frontmatter fails: %s", (_label, content) => {
  const root = dir();
  mkdirSync(join(root, "bad"));
  writeFileSync(join(root, "bad", "SKILL.md"), content);
  const result = skills(root);
  expectSpawnExit(result, 1);
  expect(result.output).toContain(`${join("bad", "SKILL.md")}:`);
});

test("a SKILL.md the measurement does not reach fails the census", () => {
  const root = dir();
  skill(root, "ok", "A valid skill.");
  skill(join(root, "group"), "nested", "Hidden.");
  const result = skills(root);
  expectSpawnExit(result, 1);
  expect(result.output).toContain(
    `${join("nested", "SKILL.md")}: skill definition never reached by the measurement`,
  );
});

test.skipIf(process.platform === "win32")(
  "two links to one skill measure it once",
  () => {
    const root = dir();
    skill(root, "alpha", "Only skill.");
    symlinkSync(join(root, "alpha"), join(root, "beta"));
    const result = skills(root);
    expectSpawnExit(result, 0);
    expect(result.output).toContain("1 skill(s)");
  },
);

test("duplicate skill names fail", () => {
  const root = dir();
  skill(root, "one", "First.");
  skill(root, "two", "Second.");
  const path = join(root, "two", "SKILL.md");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("name: two", "name: one"),
  );
  const result = skills(root);
  expectSpawnExit(result, 1);
  expect(result.output).toContain("duplicate skill name one");
});

describe.skipIf(process.platform === "win32")("a link to nothing", () => {
  test("as a SKILL.md fails, beside a valid skill", () => {
    const root = dir();
    skill(root, "ok", "A valid skill.");
    mkdirSync(join(root, "broken"));
    symlinkSync(join(root, "missing.md"), join(root, "broken", "SKILL.md"));
    const result = skills(root);
    expectSpawnExit(result, 1);
    expect(result.output).toContain(
      `${join("broken", "SKILL.md")}: unreadable (a link to nothing)`,
    );
  });

  test("as an agent file fails, in an agents-only run", () => {
    const root = dir();
    symlinkSync(join(root, "missing.md"), join(root, "gone.md"));
    const result = run(["--agents", root]);
    expectSpawnExit(result, 1);
    expect(result.output).toContain("gone.md: unreadable (a link to nothing)");
  });

  test("a FIFO SKILL.md or an agent linked to a device fails unread", () => {
    const root = dir();
    skill(root, "ok", "A valid skill.");
    mkdirSync(join(root, "pipe"));
    Bun.spawnSync(["mkfifo", join(root, "pipe", "SKILL.md")]);
    const fifo = skills(root);
    expectSpawnExit(fifo, 1);
    expect(fifo.output).toContain(
      `${join("pipe", "SKILL.md")}: unreadable (not a regular file)`,
    );
    const agents = dir();
    symlinkSync("/dev/zero", join(agents, "zero.md"));
    const device = run(["--agents", agents]);
    expectSpawnExit(device, 1);
    expect(device.output).toContain("zero.md: unreadable (not a regular file)");
  });

  test("below the measured level fails the census", () => {
    const root = dir();
    skill(root, "ok", "A valid skill.");
    mkdirSync(join(root, "group", "deep"), { recursive: true });
    symlinkSync(
      join(root, "missing.md"),
      join(root, "group", "deep", "SKILL.md"),
    );
    const result = skills(root);
    expectSpawnExit(result, 1);
    expect(result.output).toContain(
      "SKILL.md: skill definition never reached by the measurement",
    );
  });
});

test("agent files get the per-item caps; a README is not an agent", () => {
  const root = dir();
  writeFileSync(join(root, "README.md"), "# Agents\n");
  writeFileSync(
    join(root, "long.md"),
    `---\nname: long\ndescription: ${"x".repeat(1025)}\n---\n`,
  );
  const result = run(["--agents", root]);
  expectSpawnExit(result, 1);
  expect(result.output).toContain("long.md: description 1025 chars");
  expect(result.output).not.toContain("README.md");
});

test("a nested agent file the measurement does not reach fails the census", () => {
  const root = dir();
  writeFileSync(
    join(root, "top.md"),
    "---\nname: top\ndescription: Top.\n---\n",
  );
  mkdirSync(join(root, "group"));
  writeFileSync(join(root, "group", "README.md"), "# Group\n");
  writeFileSync(
    join(root, "group", "nested.md"),
    "---\nname: nested\ndescription: Nested.\n---\n",
  );
  const result = run(["--agents", root]);
  expectSpawnExit(result, 1);
  expect(result.output).toContain(
    "nested.md: agent definition never reached by the measurement",
  );
  expect(result.output).not.toContain(join("group", "README.md"));
});

test("an empty skills directory fails; an empty agents directory is noted", () => {
  const empty = skills(dir());
  expectSpawnExit(empty, 1);
  expect(empty.output).toContain("no skill to measure");
  const agents = run(["--skills", join(fixtures, "skills"), "--agents", dir()]);
  expectSpawnExit(agents, 0);
  expect(agents.output).toContain("no agent to measure");
});

test("a missing directory or no directory is a usage error", () => {
  expectSpawnExit(skills(join(scratch, "absent")), 2);
  expectSpawnExit(run([]), 2);
  expectSpawnExit(skills(dir(), "--hard", "0"), 2);
});
