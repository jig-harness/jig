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
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const script = join(import.meta.dir, "check-skill-invocation-fallback.ts");
const fixtures = join(import.meta.dir, "fixtures");
const skillsDir = join(fixtures, "skills");
const docs = join(fixtures, "docs");
const scratch = mkdtempSync(join(tmpdir(), "jig-skill-fallback-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let files = 0;
function doc(text: string): string {
  const path = join(scratch, `doc-${files++}.md`);
  writeFileSync(path, text);
  return path;
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
const check = (path: string, ...more: string[]) =>
  run(["--skill", "release-notes", ...more, path]);
const padding = (lines: number) => "filler\n".repeat(lines);

test("an invocation with a fallback beside it passes", () => {
  const result = run(["--skills", skillsDir, join(docs, "with-fallback.md")]);
  expectSpawnExit(result, 0);
  expect(result.output).toContain("1 file(s) checked for 2 skill(s)");
});

test("an invocation with no fallback fails with its place and the fix", () => {
  const result = run([
    "--skills",
    skillsDir,
    join(docs, "without-fallback.md"),
  ]);
  expectSpawnExit(result, 1);
  expect(result.output).toContain("without-fallback.md:3:");
  expect(result.output).toContain(
    "/summarize-changes names no fallback within 10 lines",
  );
  expect(result.output).toContain("fix: beside the slash command, link");
});

test("a marker exactly the window away counts, one line further does not", () => {
  const marker = "[procedure](skills/release-notes/SKILL.md)\n";
  const within = `Run /release-notes.\n${padding(9)}${marker}`;
  expectSpawnExit(check(doc(within)), 0);
  expectSpawnExit(check(doc(`${marker}${padding(9)}Run /release-notes.\n`)), 0);
  const beyond = `Run /release-notes.\n${padding(10)}${marker}`;
  expectSpawnExit(check(doc(beyond)), 1);
  expectSpawnExit(check(doc(beyond), "--window", "11"), 0);
});

test("each opening a slash command may follow is an invocation", () => {
  for (const line of [
    "/release-notes",
    "run /release-notes now",
    "run `/release-notes` now",
    "run (/release-notes) now",
    "see [/release-notes] now",
    "run /release-notes: it writes them",
    "run /release-notes.",
    "\t/release-notes <tag>",
    'run "/release-notes" now',
    "run '/release-notes' now",
    "run **/release-notes** now",
    "run _/release-notes_.",
    "run _/release-notes_ now",
    "run __/release-notes__.",
    "run __/release-notes__ now",
    "run ~~/release-notes~~ now",
    "| /release-notes | writes them |",
    "|/release-notes|",
  ]) {
    const result = check(doc(`${line}\n`));
    expectSpawnExit(result, 1, line);
  }
});

test("paths, namespaced commands and longer names are not invocations", () => {
  for (const line of [
    "the plugin's /tools:release-notes",
    "skills/release-notes/ holds it",
    "open /release-notes/README.md",
    "open /release-notes.md",
    "https://example.com/release-notes",
    "run /release-notes-draft",
    "run /release-notes_v2",
    "run /release-notes__v2",
    "a/release-notes b",
  ]) {
    const result = check(doc(`${line}\n`));
    expectSpawnExit(result, 0, line);
  }
});

test("a fallback link split across lines still counts", () => {
  const text =
    "Run /release-notes, or read [its\nprocedure](\nskills/release-notes/SKILL.md).\n";
  expectSpawnExit(check(doc(text)), 0);
  expectSpawnExit(
    check(doc("Run /release-notes from .agents/skills/release-notes/.\n")),
    0,
  );
  expectSpawnExit(
    check(doc("Run /release-notes ([other runtimes](docs/interop.md)).\n")),
    0,
  );
});

test("a fallback counts only for the skill it names", () => {
  const text =
    "Run /release-notes. See [summarize](skills/summarize-changes/SKILL.md).\n";
  const result = run(["--skills", skillsDir, doc(text)]);
  expectSpawnExit(result, 1);
  expect(result.output).toContain("/release-notes names no fallback");
  const both = `${text}Run /summarize-changes too.\n`;
  expectSpawnExit(run(["--skills", skillsDir, doc(both)]), 1);
});

test("a link resolves from its file, so a skill's own SKILL.md link counts", () => {
  const dir = join(scratch, "skills", "release-notes");
  mkdirSync(dir, { recursive: true });
  const own = join(dir, "notes.md");
  writeFileSync(own, "Run /release-notes ([it](SKILL.md)).\n");
  expectSpawnExit(check(own), 0);
  expectSpawnExit(check(doc("Run /release-notes ([it](SKILL.md)).\n")), 1);
});

test("hidden, mistargeted and unbounded markers are not fallbacks", () => {
  for (const text of [
    "Run /release-notes. <!-- [procedure](skills/release-notes/SKILL.md) -->\n",
    "Run /release-notes. [broken](skills/release-notes/SKILL.md.bak)\n",
    "Run /release-notes from .agents/skills-does-not-exist/release-notes.\n",
    "Run /release-notes from .agents/skills/release-notes-draft.\n",
    "Run /release-notes from .agents/skills/.\n",
  ]) {
    expectSpawnExit(check(doc(text)), 1, text);
  }
});

test("link syntax the renderer shows as no link is not a fallback", () => {
  for (const text of [
    "Run /release-notes. `[procedure](skills/release-notes/SKILL.md)`\n",
    "Run /release-notes. ![procedure](skills/release-notes/SKILL.md)\n",
    "Run /release-notes.\n\n```\n[procedure](skills/release-notes/SKILL.md)\n```\n",
    `\`\`\`\n${padding(20)}[procedure](skills/release-notes/SKILL.md)\n\`\`\`\nRun /release-notes.\n`,
    "Run /release-notes; read [procedure][release].\n\n```\n[release]: skills/release-notes/SKILL.md\n```\n",
  ]) {
    expectSpawnExit(check(doc(text)), 1, text);
  }
});

test("a reference link counts wherever its definition stands", () => {
  const use = "Run /release-notes; read [procedure][release].\n";
  const definition = "[release]: skills/release-notes/SKILL.md\n";
  expectSpawnExit(check(doc(`${use}\n${definition}`)), 0);
  expectSpawnExit(check(doc(`${use}${padding(30)}\n${definition}`)), 0);
  expectSpawnExit(check(doc(`${definition}${padding(30)}${use}`)), 0);
  const split = "[release]:\n  skills/release-notes/SKILL.md\n";
  expectSpawnExit(check(doc(`${use}${padding(30)}\n${split}`)), 0);
  // A definition cannot interrupt a paragraph: this one is prose.
  expectSpawnExit(check(doc(`${use}${definition}`)), 1);
  const unused = `Run /release-notes.\n\n${definition}`;
  expectSpawnExit(check(doc(unused)), 1);
});

test("an invocation inside an HTML comment is not read", () => {
  const text =
    "<!-- Run /release-notes; [procedure](skills/release-notes/SKILL.md) -->\n";
  expectSpawnExit(check(doc(text)), 0);
  expectSpawnExit(check(doc("<!--\nRun /release-notes.\n-->\n")), 0);
});

test("a mention of SKILL.md that is no link is not a fallback", () => {
  const text = "See the other SKILL.md; run /release-notes.\n";
  expectSpawnExit(check(doc(text)), 1);
});

test("--marker replaces the default marker", () => {
  const text = "Run /release-notes (see the runbook).\n";
  expectSpawnExit(check(doc(text)), 1);
  expectSpawnExit(check(doc(text), "--marker", "runbook"), 0);
  const linked = doc("Run /release-notes ([it](SKILL.md)).\n");
  expectSpawnExit(check(linked, "--marker", "runbook"), 1);
  const named = doc("Run /release-notes (runbook: release-notes).\n");
  expectSpawnExit(check(named, "--marker", "runbook: {skill}"), 0);
  const other = doc("Run /release-notes (runbook: deploy).\n");
  expectSpawnExit(check(other, "--marker", "runbook: {skill}"), 1);
});

test("a directory is scanned for Markdown files only", () => {
  const dir = join(scratch, "tree");
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, "nested", "a.md"), "Run /release-notes.\n");
  writeFileSync(join(dir, "notes.txt"), "Run /release-notes.\n");
  const result = check(dir);
  expectSpawnExit(result, 1);
  expect(result.output).toContain("a.md:1:");
  expect(result.output).not.toContain("notes.txt");
  const named = check(join(dir, "notes.txt"));
  expectSpawnExit(named, 1);
  expect(named.output).toContain("notes.txt:1:");
});

test("a linked skill directory is scanned, each real directory once", () => {
  const real = join(scratch, "real-skill");
  mkdirSync(real, { recursive: true });
  writeFileSync(join(real, "SKILL.md"), "Run /release-notes.\n");
  const mirror = join(scratch, "mirror");
  mkdirSync(mirror, { recursive: true });
  symlinkSync(real, join(mirror, "linked"), "dir");
  symlinkSync(mirror, join(mirror, "loop"), "dir");
  const result = check(mirror);
  expectSpawnExit(result, 1);
  expect(result.output).toContain("SKILL.md:1:");
});

test("a generated file on the list, with the marker in its banner, is exempt", () => {
  const generated = join(docs, "generated.md");
  const args = ["--skills", skillsDir];
  expectSpawnExit(run([...args, generated]), 1, "not on the list");
  expectSpawnExit(
    run([...args, "--exempt", generated, generated]),
    0,
    "on the list",
  );
});

test("the exemption needs the list, the banner and the marker together", () => {
  const cases: [string, string][] = [
    [
      "a marker but no banner",
      "skill-invocation-fallback: exempt-file\n- /release-notes\n",
    ],
    [
      "a banner without the marker",
      "<!-- GENERATED: do not edit. -->\n- /release-notes\n",
    ],
    [
      "the marker in a comment that is no generated banner",
      "<!-- skill-invocation-fallback: exempt-file -->\n- /release-notes\n",
    ],
    [
      "a banner below the first lines",
      `${padding(5)}<!-- GENERATED skill-invocation-fallback: exempt-file -->\n- /release-notes\n`,
    ],
  ];
  for (const [label, text] of cases) {
    const file = doc(text);
    const result = check(file, "--exempt", file);
    expectSpawnExit(result, 1, label);
    expect(result.output).toContain("on the exemption list, but");
  }
});

test("usage errors and missing inputs exit 2, never pass", () => {
  const file = doc("nothing here\n");
  const emptyDir = join(scratch, "empty");
  mkdirSync(emptyDir, { recursive: true });
  writeFileSync(join(emptyDir, "notes.txt"), "Run /x.\n");
  for (const [label, args] of [
    ["no skill", [file]],
    ["no path", ["--skill", "release-notes"]],
    ["a missing path", ["--skill", "release-notes", join(scratch, "gone.md")]],
    ["a missing skills directory", ["--skills", join(scratch, "gone"), file]],
    ["a skills directory with no skill", ["--skills", docs, file]],
    ["a directory with no Markdown", ["--skill", "x", emptyDir]],
    [
      "an exempt file that does not exist",
      ["--skill", "x", "--exempt", join(scratch, "gone.md"), file],
    ],
    [
      "an exempt file outside the scan",
      ["--skill", "x", "--exempt", join(docs, "generated.md"), file],
    ],
    [
      "an invalid templated marker",
      ["--skill", "x", "--marker", "{skill}(", file],
    ],
    ["a name that is not a skill name", ["--skill", "a b", file]],
    ["a negative window", ["--skill", "x", "--window", "-1", file]],
    [
      "a window that is not a number",
      ["--skill", "x", "--window", "ten", file],
    ],
    ["an invalid marker", ["--skill", "x", "--marker", "(", file]],
    ["an unknown option", ["--skill", "x", "--strict", file]],
  ] as [string, string[]][]) {
    const result = run(args);
    expectSpawnExit(result, 2, label);
  }
});
