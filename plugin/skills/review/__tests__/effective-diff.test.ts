import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import {
  cleanupFixtures,
  fixture,
  git,
  review,
  roots,
  setup,
  type SetupState,
} from "./review-fixture.ts";

setDefaultTimeout(60000);
afterEach(cleanupFixtures);

/** A shell word git's `sh -c` runs: the program and its script, each quoted. */
function command(script: string): string {
  return `"${process.execPath}" "${script}"`;
}

function helperScripts(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "review-diff-tools-"));
  roots.push(dir);
  const scripts = {
    // A clean filter that drops every line naming "hidden".
    strip:
      'const t=await Bun.stdin.text();process.stdout.write(t.split("\\n").filter(l=>!l.includes("hidden")).join("\\n"));',
    // An external diff and a textconv driver that each claim nothing changed.
    external: "",
    textconv: 'process.stdout.write("same\\n");',
  };
  const paths: Record<string, string> = {};
  for (const [name, source] of Object.entries(scripts)) {
    paths[name] = join(dir, `${name}.ts`);
    writeFileSync(paths[name], source);
  }
  return paths;
}

/**
 * A base with a submodule and a textconv attribute, and a change that edits
 * a file its own attributes file runs through a clean filter, edits the
 * textconv file, moves the submodule and adds an untracked file.
 */
function changedRepository(): string {
  const root = fixture();
  const sub = mkdtempSync(join(tmpdir(), "review sub "));
  roots.push(sub);
  git(sub, "init", "-b", "main");
  writeFileSync(join(sub, "inner.txt"), "inner\n");
  git(sub, "add", ".");
  git(sub, "commit", "-m", "sub base");
  git(root, "checkout", "main");
  git(root, "submodule", "add", sub, "sub");
  writeFileSync(join(root, ".gitattributes"), "*.txt diff=hide\n");
  writeFileSync(join(root, "notes.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "submodule and textconv");
  git(root, "checkout", "-B", "change", "main");
  writeFileSync(join(root, "kept.ts"), "base\nconst x = 1; // hidden\n");
  writeFileSync(
    join(root, ".gitattributes"),
    "*.txt diff=hide\nkept.ts filter=strip\nnew.ts filter=strip\n",
  );
  writeFileSync(join(root, "notes.txt"), "base\nchanged\n");
  writeFileSync(join(root, "new.ts"), "shown\nalso hidden\n");
  writeFileSync(join(root, "sub/inner.txt"), "moved\n");
  git(join(root, "sub"), "commit", "-am", "move");
  return root;
}

function callerSettings(root: string): void {
  const tools = helperScripts();
  git(root, "config", "diff.ignoreSubmodules", "all");
  git(root, "config", "diff.submodule", "diff");
  git(root, "config", "diff.relative", "true");
  git(root, "config", "diff.noprefix", "true");
  git(root, "config", "diff.external", command(tools.external ?? ""));
  git(root, "config", "diff.hide.textconv", command(tools.textconv ?? ""));
  git(root, "config", "filter.strip.clean", command(tools.strip ?? ""));
}

function read(state: SetupState) {
  return {
    files: readFileSync(state.files, "utf8").split("\0").filter(Boolean),
    diff: readFileSync(state.diff, "utf8"),
  };
}

test("the caller's diff settings and a change-declared attribute cannot hide an edit", () => {
  const root = changedRepository();
  const plain = read(setup(root));
  callerSettings(root);
  const pinned = read(setup(root));
  expect(pinned).toEqual(plain);
  expect(pinned.files).toEqual([
    ".gitattributes",
    "kept.ts",
    "new.ts",
    "notes.txt",
    "sub",
  ]);
  expect(pinned.diff).toContain("+++ b/kept.ts\n");
  expect(pinned.diff).toContain("+const x = 1; // hidden\n");
  expect(pinned.diff).toContain("+++ b/new.ts\n");
  expect(pinned.diff).toContain("+also hidden\n");
  expect(pinned.diff).toContain("+++ b/notes.txt\n");
  expect(pinned.diff).toContain("+changed\n");
  expect(pinned.diff).toContain("+++ b/sub\n");
  expect(pinned.diff).toMatch(/\n\+Subproject commit [0-9a-f]{40}\n/);
  expect(pinned.diff).not.toContain("inner.txt");
});

test("explicit files are each diffed against nothing, and a named path that does not exist stops setup", () => {
  const root = fixture();
  const state = setup(root, "kept.ts");
  expect(read(state).diff).toContain(
    "--- /dev/null\n+++ b/kept.ts\n@@ -0,0 +1 @@\n+base\n",
  );
  const missing = review(root, ["setup", "--files", "absent.ts"]);
  expectSpawnExit(missing, 1);
  expect(missing.stderr).toContain("absent.ts");
  expect(missing.stderr).toContain("does not exist");
});

test("setup stops on a git older than 2.41 and names the requirement", () => {
  const root = fixture();
  const bin = mkdtempSync(join(tmpdir(), "review-old-git-"));
  roots.push(bin);
  writeFakeProgram(
    join(bin, "git"),
    '#!/usr/bin/env bun\nif (process.argv[2] === "--version") console.log("git version 2.40.1");\nelse process.exitCode = 3;\n',
  );
  const result = review(root, ["setup"], {
    ...process.env,
    PATH: [bin, process.env.PATH ?? ""].join(delimiter),
  });
  expectSpawnExit(result, 1);
  expect(result.stderr).toContain("git 2.41 or later");
  expect(result.stderr).toContain("2.40");
  expect(result.stdout).toBe("");
});
