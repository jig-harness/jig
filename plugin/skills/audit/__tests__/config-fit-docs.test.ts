import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExitNot } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../../lib/test-helpers/windows-skip.ts";
import { runScript, scratchRepo } from "./helpers.ts";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const linkTest = test.skipIf(
  skipsOnWindows(
    "file-system",
    "creating a symbolic link needs Developer Mode or a privilege on Windows",
  ),
);

type Finding = { id: string; message: string };

function scratch(files: Record<string, string>): string {
  const dir = scratchRepo(files);
  dirs.push(dir);
  return dir;
}

/** The docs skill's refusal in config-fit's report for `dir`, or undefined. */
function docsRefusal(dir: string): Finding | undefined {
  const run = runScript("config-fit.ts", ["--offline", "--json"], dir);
  expectSpawnExitNot(
    { exitCode: run.code, stdout: run.out, stderr: run.err },
    2,
    "config-fit",
  );
  const { findings } = JSON.parse(run.out) as { findings: Finding[] };
  return findings.find((f) => f.id === "rejected:docs");
}

/** A folder outside every scratch repository, holding `schema.yaml`. */
function outside(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-audit-outside-"));
  dirs.push(dir);
  writeFileSync(join(dir, "schema.yaml"), "{}\n");
  return dir;
}

test("a configured docs root outside the repository is refused", () => {
  const dir = scratch({ ".config/jig.yaml": "docs:\n  root: ..\n" });
  expect(docsRefusal(dir)?.message).toContain(
    "docs.root names .., which leads outside the repository",
  );
});

test("a docs section the skill accepts draws no refusal", () => {
  const dir = scratch({
    ".config/jig.yaml": "docs:\n  root: handbook\n  stale_after_days: 90\n",
    "handbook/frontmatter-schema.yaml": "{}\n",
  });
  expect(docsRefusal(dir)).toBeUndefined();
});

test("a docs value the skill refuses is refused", () => {
  const dir = scratch({ ".config/jig.yaml": "docs:\n  stale_after_days: 0\n" });
  expect(docsRefusal(dir)?.message).toContain("docs.stale_after_days");
});

test("a configured docs root that is a file is refused", () => {
  const dir = scratch({
    ".config/jig.yaml": "docs:\n  root: notes.md\n  schema: schema.yaml\n",
    "notes.md": "# Notes\n",
    "schema.yaml": "{}\n",
  });
  expect(docsRefusal(dir)?.message).toContain(
    "docs.root names notes.md, which is not a directory",
  );
});

test("a configured schema that is a folder is refused", () => {
  const dir = scratch({
    ".config/jig.yaml": "docs:\n  root: docs\n  schema: docs\n",
    "docs/index.md": "# Docs\n",
  });
  expect(docsRefusal(dir)?.message).toContain(
    "docs.schema names docs, which is not a file",
  );
});

linkTest("a schema linked to a file outside the repository is refused", () => {
  const dir = scratch({
    ".config/jig.yaml": "docs:\n  schema: docs/schema.yaml\n",
    "docs/.keep": "",
  });
  symlinkSync(join(outside(), "schema.yaml"), join(dir, "docs/schema.yaml"));
  expect(docsRefusal(dir)?.message).toContain(
    "docs.schema names docs/schema.yaml, which leads outside the repository",
  );
});

linkTest(
  "a detected docs root linked outside the repository is refused",
  () => {
    const dir = scratch({ ".config/jig.yaml": "docs: {}\n" });
    symlinkSync(outside(), join(dir, "docs"));
    expect(docsRefusal(dir)?.message).toContain(
      "docs.root names docs, which leads outside the repository",
    );
  },
);
