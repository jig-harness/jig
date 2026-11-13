/**
 * The generator reaches every input (M2 § Generators reach every input): the
 * inventory entry's sources name every file a chapter's sections import, and
 * each chapter renders or explicitly leaves out every entry of the tables it
 * draws from, enumerated here on their own.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { load } from "../../../lib/vendor/js-yaml.mjs";
import { TERMINAL_STATES } from "../../../plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { CHAPTERS } from "../chapters.ts";
import { DRIVE_EXITS } from "../chapters/drive-exits.ts";

const root = join(import.meta.dir, "..", "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

interface Entry {
  outputs: string[];
  source: string[];
}

/** The protocol area's generated-file entry in the change-area catalog. */
function inventoryEntry(): Entry {
  const catalog = load(read(".config/change-areas.yaml")) as {
    areas: Record<string, { generated?: Entry[] }>;
  };
  const entry = catalog.areas.protocol?.generated?.[0];
  if (entry === undefined)
    throw new Error("the catalog has no protocol area with a generated entry");
  return entry;
}

/** The repository files a module imports by relative path. */
function importsOf(module: string): string[] {
  const scanned = new Bun.Transpiler({ loader: "ts" }).scanImports(
    read(module),
  );
  return scanned
    .map((i) => i.path)
    .filter((p) => p.startsWith("."))
    .map((p) =>
      relative(root, join(root, dirname(module), p)).replaceAll("\\", "/"),
    );
}

const matchesAny = (globs: readonly string[], path: string) =>
  globs.some((g) => new Bun.Glob(g).match(path));

/** The files `module` imports that no glob of `source` matches. */
function unlisted(module: string, source: readonly string[]): string[] {
  return [module, ...importsOf(module)].filter((p) => !matchesAny(source, p));
}

describe("the inventory entry's sources", () => {
  const entry = inventoryEntry();

  test("name every file a chapter's sections import", () => {
    for (const chapter of CHAPTERS)
      expect({
        chapter: chapter.id,
        unlisted: unlisted(chapter.module, entry.source),
      }).toEqual({ chapter: chapter.id, unlisted: [] });
  });

  test("would miss a module a chapter imported without listing it", () => {
    expect(
      unlisted(DRIVE_EXITS.module, ["tools/protocol/**"]).filter(
        (p) => !p.startsWith("tools/"),
      ),
    ).toEqual(["plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts"]);
  });

  test("are the files the pre-commit hook regenerates the chapters for", () => {
    const hooks = load(read("lefthook.yml")) as {
      "pre-commit": { commands: Record<string, { glob?: string[] }> };
    };
    expect(hooks["pre-commit"].commands.protocol?.glob).toEqual(entry.source);
  });

  test("list every chapter, the index page and every data file as outputs", () => {
    expect([...entry.outputs].sort()).toEqual(
      [
        "plugin/protocol/README.md",
        ...CHAPTERS.flatMap((c) => [
          `plugin/protocol/${c.id}.md`,
          `plugin/protocol/data/${c.id}.json`,
        ]),
      ].sort(),
    );
  });
});

describe("the drive's end states and exit codes", () => {
  // Enumerated from the code's table on its own, not through the chapter.
  const table = Object.keys(TERMINAL_STATES).filter(
    (name) => TERMINAL_STATES[name] !== undefined,
  );
  const rendered = DRIVE_EXITS.values().map((v) => String(v.name));
  const excluded = DRIVE_EXITS.excluded;

  test("renders or explicitly leaves out every entry of TERMINAL_STATES", () => {
    expect(
      table.filter((n) => !rendered.includes(n) && !excluded.includes(n)),
    ).toEqual([]);
  });

  test("renders and leaves out only entries TERMINAL_STATES holds, and none both", () => {
    expect(
      [...rendered, ...excluded].filter((n) => !table.includes(n)),
    ).toEqual([]);
    expect(rendered.filter((n) => excluded.includes(n))).toEqual([]);
  });

  test("shows every entry it renders in one of its generated sections", () => {
    const text = DRIVE_EXITS.sections.map((s) => s.render()).join("\n");
    expect(rendered.filter((n) => !text.includes(`| \`${n}\` |`))).toEqual([]);
  });
});
