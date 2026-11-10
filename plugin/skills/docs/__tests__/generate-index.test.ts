import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
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
} from "../scripts/index/generate-index";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import {
  documentFields,
  frontmatterValue,
  isGeneratedIndexPage,
} from "../scripts/lib/docs";
import { cleanEnv, repository } from "./helpers.ts";

let root: string;
let docs: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jig-index-"));
  docs = join(root, "docs");
  cpSync(join(import.meta.dir, "fixtures/index/docs"), docs, {
    recursive: true,
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (args: string[], env: Record<string, string> = {}) =>
  Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "../scripts/index/generate-index.ts"),
      ...args,
    ],
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

describe("regenerate.ts", () => {
  const REGENERATE = join(import.meta.dir, "../scripts/index/regenerate.ts");
  const regenerate = (repo: string, args: string[] = []) => {
    const result = spawnSync(process.execPath, [REGENERATE, ...args], {
      cwd: repo,
      env: cleanEnv(),
    });
    return {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };

  test("writes the index of the configured root, whatever characters it holds", () => {
    const tree = "hand book/$(touch pwned)'x";
    const repo = repository({
      ".config/jig.yaml": `docs:\n  root: "${tree}"\n`,
      [`${tree}/a.md`]: "# A\n",
    });
    expectSpawnExit(regenerate(repo), 0);
    expect(readFileSync(join(repo, tree, "INDEX.md"), "utf8")).toContain(
      "a.md",
    );
    expect(existsSync(join(repo, "pwned"))).toBe(false);
    expectSpawnExit(regenerate(repo, ["--check"]), 0);
  });

  test("refuses when no docs tree is configured or detected", () => {
    const result = regenerate(repository({ "README.md": "# R\n" }));
    expectSpawnExit(result, 2);
    expect(result.stderr).toContain("no docs tree");
  });
});

describe("INDEX.md layout settings", () => {
  const FRONTMATTER = {
    title: "Documentation index",
    type: "reference",
    status: "active",
    lifecycle: "permanent",
    owner: "docs",
    tags: ["navigation"],
  };
  const withIndex = (options: Parameters<typeof generateIndex>[2]) =>
    generateIndex(docs, outputs(), options);

  test("no setting leaves the bare listing", () => {
    expect(withIndex({})).toBe(generateIndex(docs, outputs()));
    expect(withIndex({})).toBe(read("INDEX.md"));
  });

  test("a preamble sits verbatim above the listing, after the title", () => {
    const text = withIndex({
      preambleText: "## Start here\n\nRead [a](a.md).\n",
    });
    expect(text).toContain(
      "# Documentation index\n\n## Start here\n\nRead [a](a.md).\n\n## (root)",
    );
  });

  test("an inherited property is no configured description", () => {
    mkdirSync(join(docs, "constructor"));
    writeFileSync(join(docs, "constructor", "a.md"), "---\ntitle: A\n---\n");
    expect(withIndex({ descriptions: {} })).toContain(
      "## constructor\n\n| Doc |",
    );
  });

  test("frontmatter values are written so the reader reads them back", () => {
    const fields = { title: "Guide # intro", tags: ["a: b", "c, d", "plain"] };
    const text = withIndex({ frontmatter: fields });
    expect(frontmatterValue(text, "title", "INDEX.md")).toBe("Guide # intro");
    expect(documentFields(text, "INDEX.md").get("tags")).toEqual(fields.tags);
  });

  test("a description follows its category's heading", () => {
    const text = withIndex({ descriptions: { guides: "How-to pages." } });
    expect(text).toContain("## guides\n\nHow-to pages.\n\n| Doc |");
    expect(text).not.toContain("## architecture\n\n\n");
  });

  test("a category without a configured description takes its README's", () => {
    writeFileSync(
      join(docs, "guides", "README.md"),
      "---\ntitle: Guides\ndescription: From the README\n---\n\n# Guides\n",
    );
    const options = {
      descriptions: { architecture: "Configured" },
      descriptionsFromReadme: true,
    };
    const text = withIndex(options);
    expect(text).toContain("## guides\n\nFrom the README\n\n");
    expect(text).toContain("## architecture\n\nConfigured\n\n");
    expect(
      withIndex({ ...options, descriptionsFromReadme: false }),
    ).not.toContain("From the README\n\n|");
  });

  test("categories order by name, by count, or as listed", () => {
    writeFileSync(join(docs, "guides", "extra.md"), "# Extra\n");
    const headings = (order: Parameters<typeof generateIndex>[2]) =>
      [...withIndex(order).matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings({})).toEqual(["(root)", "architecture", "guides"]);
    expect(headings({ order: "count" })[0]).toBe("guides");
    expect(headings({ order: ["guides", "gone", "architecture"] })).toEqual([
      "guides",
      "architecture",
      "(root)",
    ]);
  });

  test("frontmatter is stamped, keeps its date until the content changes, and passes the gate", () => {
    const first = withIndex({
      frontmatter: FRONTMATTER,
      today: "2026-01-01",
    });
    expect(first.startsWith("---\ntitle: Documentation index\n")).toBe(true);
    expect(first).toContain(
      "tags: [navigation]\nlast_updated: 2026-01-01\n---\n\n<!-- AUTO",
    );
    expect(
      withIndex({
        frontmatter: FRONTMATTER,
        today: "2026-02-02",
        existing: first,
      }),
    ).toBe(first);
    const changed = withIndex({
      frontmatter: FRONTMATTER,
      today: "2026-02-02",
      existing: first,
      descriptions: { guides: "New." },
    });
    expect(changed).toContain("last_updated: 2026-02-02");

    writeFileSync(join(docs, "INDEX.md"), first);
    const result = Bun.spawnSync(
      [
        process.execPath,
        join(
          import.meta.dir,
          "../scripts/frontmatter-check/frontmatter-check.ts",
        ),
        join(docs, "INDEX.md"),
      ],
      {
        env: {
          ...process.env,
          DOCS_DIR: docs,
          SCHEMA: join(
            import.meta.dir,
            "fixtures/frontmatter-check/schema.yaml",
          ),
          NEW_DOCS: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expectSpawnExit(result, 0);
    // A field the schema does not allow is reported: the index is not exempt.
    writeFileSync(
      join(docs, "INDEX.md"),
      first.replace("type: reference", "type: nonsense"),
    );
    expectSpawnExit(
      Bun.spawnSync(
        [
          process.execPath,
          join(
            import.meta.dir,
            "../scripts/frontmatter-check/frontmatter-check.ts",
          ),
          join(docs, "INDEX.md"),
        ],
        {
          env: {
            ...process.env,
            DOCS_DIR: docs,
            SCHEMA: join(
              import.meta.dir,
              "fixtures/frontmatter-check/schema.yaml",
            ),
            NEW_DOCS: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      ),
      1,
    );
  });
});

describe("docs.index from the configuration", () => {
  const REGENERATE = join(import.meta.dir, "../scripts/index/regenerate.ts");
  const regenerate = (repo: string, args: string[] = []) => {
    const result = spawnSync(process.execPath, [REGENERATE, ...args], {
      cwd: repo,
      env: cleanEnv(),
    });
    return {
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  const config = `docs:
  root: docs
  index:
    preamble: docs/.index-preamble.txt
    descriptions:
      guides: How-to pages.
    order: [guides]
    frontmatter:
      title: Documentation index
      type: reference
`;
  const files = {
    ".config/jig.yaml": config,
    "docs/.index-preamble.txt": "## Start here\n\nRead the guides first.\n",
    "docs/guides/a.md": "# A\n",
    "docs/b.md": "# B\n",
  };

  test("the generator reads the settings, and the freshness check holds to them", () => {
    const repo = repository(files);
    expectSpawnExit(regenerate(repo), 0);
    const text = readFileSync(join(repo, "docs/INDEX.md"), "utf8");
    expect(text).toContain(
      "title: Documentation index\ntype: reference\nlast_updated: ",
    );
    expect(text).toContain(
      "## Start here\n\nRead the guides first.\n\n## guides\n\nHow-to pages.",
    );
    expect(text.indexOf("## guides")).toBeLessThan(text.indexOf("## (root)"));
    expectSpawnExit(regenerate(repo, ["--check"]), 0);
    writeFileSync(join(repo, "docs/.index-preamble.txt"), "Changed.\n");
    expectSpawnExit(regenerate(repo, ["--check"]), 1);
  });

  const refused: [string, string, string][] = [
    [
      "an unknown field",
      "    colour: red\n",
      "docs.index has unknown field colour",
    ],
    ["a bad order", "    order: sideways\n", "docs.index.order must be"],
    ["a missing preamble", "    preamble: nope.md\n", "which does not exist"],
    [
      "a preamble outside the repository",
      "    preamble: ../outside.md\n",
      "does not exist",
    ],
    [
      "a stamped field",
      "    frontmatter:\n      last_updated: 2026-01-01\n",
      "last_updated is stamped",
    ],
    [
      "a multi-line description",
      '    descriptions:\n      guides: "a\\nb"\n',
      "docs.index.descriptions must be",
    ],
  ];
  for (const [name, index, message] of refused)
    test(`refuses ${name}`, () => {
      const repo = repository({
        "docs/a.md": "# A\n",
        ".config/jig.yaml": `docs:\n  root: docs\n  index:\n${index}`,
      });
      const result = regenerate(repo);
      expectSpawnExit(result, 2);
      expect(result.stderr).toContain(message);
    });
});

describe("recognising a generated index", () => {
  const marker =
    "<!-- AUTO-GENERATED by generate-index.ts — do not edit by hand. -->";
  test("the marker opens the page, or follows its frontmatter", () => {
    expect(isGeneratedIndexPage(`${marker}\n\n# Documentation index\n`)).toBe(
      true,
    );
    expect(isGeneratedIndexPage(`---\ntitle: T\n---\n\n${marker}\n`)).toBe(
      true,
    );
    expect(isGeneratedIndexPage("---\ntitle: T\n---\n\n# Other\n")).toBe(false);
    expect(isGeneratedIndexPage(`---\ntitle: T\n\n${marker}\n`)).toBe(false);
    expect(isGeneratedIndexPage("# Other\n")).toBe(false);
  });
});
