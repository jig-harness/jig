import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findOrphans,
  generateIndex,
  generateOrphans,
  renderOrphans,
} from "./generate-index";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

let root: string;
let docs: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jig-index-"));
  docs = join(root, "docs");
  cpSync(join(import.meta.dir, "fixtures/docs"), docs, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "generate-index.ts"), ...args],
    {
      env: { ...process.env, DOCS_DIR: docs, ...env },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
const check = () => run(["--check"]);
const read = (name: string) => readFileSync(join(docs, name), "utf8");
/** The generated files, which the index and the report leave out. */
const outputs = () => [join(docs, "INDEX.md"), join(docs, ".orphans.md")];

describe("INDEX.md", () => {
  test("the fixture index reproduces exactly and an added doc makes the gate fail", () => {
    expect(generateIndex(docs, outputs())).toBe(read("INDEX.md"));
    expectSpawnExit(check(), 0);
    writeFileSync(join(docs, "added.md"), "# Added\n");
    const result = check();
    expectSpawnExit(result, 1);
    expect(result.stdout.toString()).toContain("INDEX.md is stale");
    expect(read("INDEX.md")).not.toContain("added.md");
  });
});

describe("generator inputs", () => {
  test("a description over several lines stays one table row, '|' escaped", () => {
    writeFileSync(
      join(docs, "multi.md"),
      "---\ntitle: A | B\ndescription: |\n  one\n  two\n---\n",
    );
    expect(generateIndex(docs, outputs())).toContain(
      "| [multi.md](multi.md) | A \\| B | one two |\n",
    );
  });

  test("a nested INDEX.md is an ordinary document; only the outputs are left out", () => {
    writeFileSync(
      join(docs, "guides/INDEX.md"),
      "---\ntitle: Guides\nrelated: [quick-tips.md]\n---\n",
    );
    expect(generateIndex(docs, outputs())).toContain("guides/INDEX.md");
    expect(findOrphans(docs, { exclude: outputs() })).not.toContain(
      "guides/quick-tips.md",
    );
  });

  test("present but unreadable frontmatter is an error, naming the document", () => {
    writeFileSync(join(docs, "bad.md"), "---\ntitle: &t Bad\n---\n");
    const result = check();
    expectSpawnExit(result, 2);
    expect(result.stderr.toString()).toContain(
      "bad.md: unreadable frontmatter",
    );
  });

  test("an unknown argument is an error and writes nothing", () => {
    const before = read("INDEX.md");
    writeFileSync(join(docs, "added.md"), "# Added\n");
    const result = run(["--chek"]);
    expectSpawnExit(result, 2);
    expect(result.stderr.toString()).toContain("unknown argument: --chek");
    expect(read("INDEX.md")).toBe(before);
  });

  test("OUT and ORPHANS naming one file is an error", () => {
    const same = join(docs, "same.md");
    const result = run([], { OUT: same, ORPHANS: same });
    expectSpawnExit(result, 2);
    expect(result.stderr.toString()).toContain("need two files");
  });
});

describe("orphan report", () => {
  test("links resolve from the report's own directory", () => {
    const { content } = generateOrphans(docs, null, "2099-12-31", {
      exclude: [...outputs(), join(docs, "reports/orphans.md")],
      report: join(docs, "reports/orphans.md"),
    });
    expect(content).toContain(
      "- [guides/quick-tips.md](../guides/quick-tips.md)",
    );
  });

  test("lists the documents no related: list names, resolved per referring doc", () => {
    // caching names deploy inline; deploy names caching and getting-started
    // in a block list, and itself.
    expect(findOrphans(docs, { exclude: outputs() })).toEqual([
      "guides/quick-tips.md",
    ]);
  });

  test("a document naming only itself stays an orphan", () => {
    writeFileSync(
      join(docs, "self.md"),
      "---\ntitle: Self\nrelated: [self.md]\n---\n",
    );
    expect(findOrphans(docs, { exclude: outputs() })).toContain("self.md");
  });

  test("the committed report reproduces exactly, whatever today is", () => {
    const existing = read(".orphans.md");
    const { content, count } = generateOrphans(docs, existing, "2099-12-31", {
      exclude: outputs(),
    });
    expect(content).toBe(existing);
    expect(count).toBe(1);
  });

  test("a changed orphan set advances the date to today", () => {
    writeFileSync(join(docs, "added.md"), "# Added\n");
    const { content } = generateOrphans(
      docs,
      read(".orphans.md"),
      "2099-12-31",
      { exclude: outputs() },
    );
    expect(content).toContain("last_updated: 2099-12-31");
    expect(content).toContain("- [added.md](added.md)");
  });

  test("--check fails on report drift alone, and orphans never fail it", () => {
    const fresh = check();
    expectSpawnExit(fresh, 0);
    expect(fresh.stdout.toString()).toContain("WARN — 1 orphaned doc(s)");
    writeFileSync(
      join(docs, ".orphans.md"),
      read(".orphans.md").replace("owner: docs", "owner: operations"),
    );
    const drift = check();
    expectSpawnExit(drift, 1);
    expect(drift.stdout.toString()).toContain(".orphans.md is stale");
    expect(drift.stdout.toString()).not.toContain("INDEX.md is stale");
  });

  test("an entry starting with / resolves from the repository root", () => {
    const exclude = outputs();
    writeFileSync(
      join(docs, "guides/quick-tips.md"),
      "---\ntitle: Tips\nrelated: [/docs/added.md]\n---\n",
    );
    writeFileSync(join(docs, "added.md"), "# Added\n");
    expect(findOrphans(docs, { exclude, root })).not.toContain("added.md");
    // From a root where /docs/ is not this tree, the entry names nothing here.
    expect(findOrphans(docs, { exclude, root: docs })).toContain("added.md");
  });

  test("the report's frontmatter values default to the template schema's and can be set", () => {
    expect(renderOrphans([], "2026-01-01")).toContain("owner: docs\n");
    const custom = renderOrphans([], "2026-01-01", {
      owner: "platform",
      tags: "[docs-health]",
    });
    expect(custom).toContain("owner: platform\n");
    expect(custom).toContain("tags: [docs-health]\n");
    expect(custom).toContain("type: reference\n");
  });

  test("an empty orphan set says so", () => {
    expect(renderOrphans([], "2026-01-01")).toContain("None: every document");
  });
});
