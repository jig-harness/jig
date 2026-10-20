import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLifecycleMap } from "./check-lifecycle-map.ts";

const root = join(import.meta.dir, "..");
const temporary: string[] = [];
afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

/** A scratch repository holding `files`, outside any git work tree. */
function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-lifecycle-"));
  temporary.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

const skill = "---\nname: x\ndescription: x\n---\n";
const map = (owner: string) =>
  `| Stage | Owner | Hands on |\n|---|---|---|\n| file | ${owner} | an issue |\n`;
const repo = (owner: string, agents = "[map](docs/LIFECYCLE.md)\n") => ({
  "docs/LIFECYCLE.md": map(owner),
  "AGENTS.md": agents,
  "plugin/skills/file-issue/SKILL.md": skill,
});

test("Jig's own lifecycle map resolves", () =>
  expect(checkLifecycleMap(root)).toBe(0));

test("a repository whose map resolves, is linked and covers its skills passes", () =>
  expect(checkLifecycleMap(scratch(repo("`/jig:file-issue`")))).toBe(0));

test("an owner that is not a skill the plugin ships fails", () =>
  expect(checkLifecycleMap(scratch(repo("`/jig:gone`")))).toBe(1));

test("a plugin skill the map never names fails", () =>
  expect(
    checkLifecycleMap(
      scratch({
        ...repo("`/jig:file-issue`"),
        "plugin/skills/other/SKILL.md": skill,
      }),
    ),
  ).toBe(1));

test("an instruction file that does not link the map fails", () =>
  expect(
    checkLifecycleMap(scratch(repo("`/jig:file-issue`", "no link\n"))),
  ).toBe(1));

test("a document that names a skill the plugin lacks fails, and a plan or the changelog may", () => {
  const files = repo("`/jig:file-issue`");
  expect(
    checkLifecycleMap(
      scratch({ ...files, "docs/process.md": "`/jig:gone`\n" }),
    ),
  ).toBe(1);
  expect(
    checkLifecycleMap(
      scratch({
        ...files,
        "design/plan.md": "`/jig:planned`\n",
        "CHANGELOG.md": "Removed `/jig:old`.\n",
        "changes/x.md": "`/jig:old`\n",
      }),
    ),
  ).toBe(0);
});

test("no map is a gate that could not check", () =>
  expect(checkLifecycleMap(scratch({ "AGENTS.md": "x\n" }))).toBe(2));
