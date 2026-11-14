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
import { encode } from "../../../plugin/shared/records/envelope.ts";
import {
  FOLLOWUP_FIELDS,
  FOLLOWUP_OUTCOMES,
  FOLLOWUP_RUNS,
} from "../../../plugin/shared/records/followup-values.ts";
import {
  NOT_RECORDS,
  RECORD_KINDS,
} from "../../../plugin/shared/records/registry.ts";
import { TERMINAL_STATES } from "../../../plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { CHAPTERS } from "../chapters.ts";
import { COMMENT_MARKERS } from "../chapters/comment-markers.ts";
import { DRIVE_EXITS } from "../chapters/drive-exits.ts";
import { FOLLOWUP_CLAIM_CHAPTER } from "../chapters/followup-claim.ts";

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

/** The repository files a module imports by relative path, directly. */
function directImports(module: string): string[] {
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

/**
 * Every repository file a module imports, followed through the files it
 * imports in turn, so a table that imports another table is reached too.
 */
function importsOf(module: string): string[] {
  const seen = new Set<string>();
  const visit = (path: string) => {
    for (const next of directImports(path))
      if (!seen.has(next)) {
        seen.add(next);
        visit(next);
      }
  };
  visit(module);
  seen.delete(module);
  return [...seen].sort();
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

  test("would miss a module a chapter imports, directly or through another, without listing it", () => {
    const table =
      "plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts";
    expect(unlisted(DRIVE_EXITS.module, ["tools/protocol/**"])).toContain(
      table,
    );
    // The table's own imports are reached through it, not by the chapter.
    expect(directImports(DRIVE_EXITS.module)).not.toContain(
      "plugin/shared/errors.ts",
    );
    expect(
      unlisted(DRIVE_EXITS.module, ["tools/protocol/**", table]),
    ).toContain("plugin/shared/errors.ts");
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

/** Every generated section of a chapter, as one text. */
const sectionsOf = (chapter: typeof DRIVE_EXITS) =>
  chapter.sections.map((s) => s.render()).join("\n");

/** The names a chapter's sections show in a table's first column. */
const missingRows = (chapter: typeof DRIVE_EXITS, names: readonly string[]) => {
  const text = sectionsOf(chapter);
  return names.filter((n) => !text.includes(`| \`${n}\` |`));
};

describe("the hidden comment markers", () => {
  // Enumerated from the registry on its own, not through the chapter: every
  // kind on the forge or the tracker is the chapter's to list or leave out.
  const eligible = RECORD_KINDS.filter(
    (k) => k.medium === "forge" || k.medium === "tracker",
  ).map((k) => k.name);
  const values = COMMENT_MARKERS.values();
  const rendered = values
    .filter((v) => v.name !== null)
    .map((v) => String(v.name));
  const excluded = COMMENT_MARKERS.excluded;

  test("renders or explicitly leaves out every forge and tracker kind of the registry", () => {
    expect(
      eligible.filter((n) => !rendered.includes(n) && !excluded.includes(n)),
    ).toEqual([]);
  });

  test("renders and leaves out only forge and tracker kinds, and none both", () => {
    expect(
      [...rendered, ...excluded].filter((n) => !eligible.includes(n)),
    ).toEqual([]);
    expect(rendered.filter((n) => excluded.includes(n))).toEqual([]);
  });

  test("renders a kind only with its markers, and leaves the follow-up claim to its own chapter", () => {
    for (const v of values) expect(v.markers).not.toBe("");
    expect(excluded).toContain("dispatch-followup");
    expect(FOLLOWUP_CLAIM_CHAPTER.takes()).toContain(
      "plugin/shared/records/registry.ts#RECORD_KINDS.dispatch-followup",
    );
  });

  test("renders every marker that is not a record, and no other value without a kind", () => {
    expect(values.filter((v) => v.name === null).map((v) => v.markers)).toEqual(
      NOT_RECORDS.map((r) => r.marker),
    );
  });

  test("carries each kind's meaning as the registry holds it, so an empty one reaches the gate", () => {
    for (const v of values.filter((v) => v.name !== null))
      expect(v.meaning).toBe(
        RECORD_KINDS.find((k) => k.name === v.name)?.meaning ?? "(none)",
      );
  });

  test("shows every kind it renders or leaves out, every non-record and every envelope field in its sections", () => {
    // The envelope's fields as the codec writes them, generation included.
    const written = Object.keys(
      JSON.parse(
        encode(
          {
            kind: "drive-ledger",
            v: 1,
            key: "1",
            writer: { host: "h" },
            at: "2026-01-01T00:00:00.000Z",
            generation: 1,
          },
          {},
        ),
      ) as object,
    );
    expect(
      missingRows(COMMENT_MARKERS, [
        ...rendered,
        ...excluded,
        ...NOT_RECORDS.map((r) => r.marker),
        ...written,
      ]),
    ).toEqual([]);
  });
});

describe("the follow-up claim and its result", () => {
  const values = FOLLOWUP_CLAIM_CHAPTER.values();
  const of = (kind: string) =>
    values
      .filter((v) => v.kind === kind || String(v.kind).endsWith(`-${kind}`))
      .map((v) => (v.run === null ? String(v.name) : `${v.run}.${v.name}`));

  test("renders the registry's follow-up kind, every run and every run's outcomes, and nothing else", () => {
    expect(of("record")).toEqual(
      RECORD_KINDS.filter((k) => k.name === "dispatch-followup").map(
        (k) => k.name,
      ),
    );
    expect(of("run")).toEqual(Object.keys(FOLLOWUP_RUNS));
    expect(of("outcome")).toEqual(
      Object.entries(FOLLOWUP_OUTCOMES).flatMap(([run, outcomes]) =>
        Object.keys(outcomes).map((o) => `${run}.${o}`),
      ),
    );
    expect(values).toHaveLength(
      of("record").length + of("run").length + of("outcome").length,
    );
    expect(FOLLOWUP_CLAIM_CHAPTER.excluded).toEqual([]);
  });

  test("shows the kind, every run, every outcome and every payload field in its sections", () => {
    const outcomes = Object.values(FOLLOWUP_OUTCOMES).flatMap((o) =>
      Object.keys(o),
    );
    expect(
      missingRows(FOLLOWUP_CLAIM_CHAPTER, [
        "dispatch-followup",
        ...Object.keys(FOLLOWUP_RUNS),
        ...outcomes,
        ...Object.keys(FOLLOWUP_FIELDS),
      ]),
    ).toEqual([]);
  });
});
