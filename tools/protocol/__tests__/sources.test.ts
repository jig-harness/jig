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
import {
  ENVELOPE_FIELDS,
  encode,
} from "../../../plugin/shared/records/envelope.ts";
import {
  FOLLOWUP_FIELDS,
  FOLLOWUP_OUTCOMES,
  FOLLOWUP_RUNS,
} from "../../../plugin/shared/records/followup-values.ts";
import {
  FORGE_CLAIM_FIELDS,
  LAUNCH_CLAIM_VALUES,
} from "../../../plugin/shared/records/forge-claim-values.ts";
import {
  NOT_RECORDS,
  RECORD_KINDS,
} from "../../../plugin/shared/records/registry.ts";
import { SEND_VERBS } from "../../../plugin/send/lib/verb-values.ts";
import { STATIONS } from "../../../plugin/shared/address.ts";
import {
  ADAPTER_FACET_STORES,
  type AdapterStoreCells,
  FACET_STORE_REASONS,
  FACET_STORES,
  FACET_TABLE,
  PRIORITIES,
} from "../../../plugin/skills/do-item/scripts/lib/tracker/facets/facet-values.ts";
import { TERMINAL_STATES } from "../../../plugin/skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { CHAPTERS } from "../chapters.ts";
import { ADDRESSES } from "../chapters/addresses.ts";
import { COMMENT_MARKERS } from "../chapters/comment-markers.ts";
import { DRIVE_EXITS } from "../chapters/drive-exits.ts";
import { FOLLOWUP_CLAIM_CHAPTER } from "../chapters/followup-claim.ts";
import { FORGE_CLAIMS_CHAPTER } from "../chapters/forge-claims.ts";
import { TRACKER_FACETS } from "../chapters/tracker-facets.ts";

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
function directImports(module: string, source = read): string[] {
  const scanned = new Bun.Transpiler({ loader: "ts" }).scanImports(
    source(module),
  );
  return scanned
    .map((i) => i.path)
    .filter((p) => p.startsWith("."))
    .map((p) =>
      relative(root, join(root, dirname(module), p)).replaceAll("\\", "/"),
    );
}

/** Script files whose imports are followed; data files such as JSON are leaves. */
const CODE_FILE = /\.[cm]?[jt]sx?$/;

/**
 * Every repository file a module imports, followed through the code files it
 * imports in turn, so a table that imports another table, or a re-exporting
 * `.mjs` bridge, is reached too.
 */
function importsOf(module: string, source = read): string[] {
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (!CODE_FILE.test(path)) return;
    for (const next of directImports(path, source))
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

  test("follow a non-.ts code module but not a data file", () => {
    const files: Record<string, string> = {
      "a/chapter.ts": 'import "./bridge.mjs"; import "./data.json";',
      "a/bridge.mjs": 'export * from "./values.ts";',
      "a/values.ts": "export const v = 1;",
      "a/data.json": '{"x": 1}',
    };
    const source = (path: string) => files[path] ?? "";
    expect(importsOf("a/chapter.ts", source)).toEqual([
      "a/bridge.mjs",
      "a/data.json",
      "a/values.ts",
    ]);
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
          ...(c.schemas ?? []).map(
            (schema) => `plugin/protocol/schemas/${schema.name}.json`,
          ),
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
  const all = COMMENT_MARKERS.values();
  const values = all.filter((v) => v.part !== "envelope-field");
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

  test("renders one value for each marker of a kind, each marker once, and leaves the follow-up claim to its own chapter", () => {
    for (const v of values) expect(v.marker).not.toBe("");
    const markers = values.map((v) => v.marker);
    expect(new Set(markers).size).toBe(markers.length);
    for (const name of new Set(rendered))
      expect(
        values.filter((v) => v.name === name).map((v) => v.marker),
      ).toEqual([
        ...(RECORD_KINDS.find((k) => k.name === name)?.markers ?? []),
      ]);
    expect(excluded).toContain("dispatch-followup");
    expect(FOLLOWUP_CLAIM_CHAPTER.takes()).toContain(
      "plugin/shared/records/registry.ts#RECORD_KINDS.dispatch-followup",
    );
    // Each forge claim it leaves out is taken by a chapter of its own.
    for (const name of Object.keys(FORGE_CLAIM_FIELDS)) {
      expect(excluded).toContain(name);
      expect(FORGE_CLAIMS_CHAPTER.takes()).toContain(
        `plugin/shared/records/registry.ts#RECORD_KINDS.${name}`,
      );
    }
  });

  test("renders every field of the envelope as a value of its own, with its type and requiredness", () => {
    expect(
      all
        .filter((v) => v.part === "envelope-field")
        .map((v) => [v.marker, v.fieldType, v.fieldRequired]),
    ).toEqual(
      Object.entries(ENVELOPE_FIELDS).map(([name, f]) => [
        name,
        f.type,
        f.required,
      ]),
    );
  });

  test("keeps a value's identity apart from its kind, so a withdrawal to a tombstone stays representable", () => {
    expect(COMMENT_MARKERS.fields.kind?.identifies).toBe(false);
    for (const v of all) expect(v.kind).toBe("active");
    const identities = all.map((v) => JSON.stringify([v.part, v.marker]));
    expect(new Set(identities).size).toBe(identities.length);
  });

  test("renders every marker that is not a record, and no other value without a kind", () => {
    expect(values.filter((v) => v.name === null).map((v) => v.marker)).toEqual(
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
      .map((v) => String(v.name));

  test("renders the registry's follow-up kind and its markers, every run, every run's outcomes and every payload field, and nothing else", () => {
    const kind = RECORD_KINDS.find((k) => k.name === "dispatch-followup");
    expect(of("record")).toEqual(kind === undefined ? [] : [kind.name]);
    expect(of("marker")).toEqual([...(kind?.markers ?? [])]);
    expect(of("run")).toEqual(Object.keys(FOLLOWUP_RUNS));
    expect(of("outcome")).toEqual(
      Object.entries(FOLLOWUP_OUTCOMES).flatMap(([run, outcomes]) =>
        Object.keys(outcomes).map((o) => `${run}.${o}`),
      ),
    );
    expect(of("field")).toEqual(Object.keys(FOLLOWUP_FIELDS));
    expect(values).toHaveLength(
      ["record", "marker", "run", "outcome", "field"].reduce(
        (n, k) => n + of(k).length,
        0,
      ),
    );
    expect(FOLLOWUP_CLAIM_CHAPTER.excluded).toEqual([]);
  });

  test("keeps a value's identity apart from its kind, so a withdrawal to a tombstone stays representable", () => {
    expect(FOLLOWUP_CLAIM_CHAPTER.fields.kind?.identifies).toBe(false);
    const identities = values.map((v) => JSON.stringify([v.name]));
    expect(new Set(identities).size).toBe(identities.length);
  });

  test("shows the kind, every run, every field and each run's own outcomes in its sections", () => {
    expect(
      missingRows(FOLLOWUP_CLAIM_CHAPTER, [
        "dispatch-followup",
        ...Object.keys(FOLLOWUP_RUNS),
        ...Object.keys(FOLLOWUP_FIELDS),
      ]),
    ).toEqual([]);
    // Each outcome with its run: a row for one run's outcome does not
    // stand in for the same name under another run.
    const rows = sectionsOf(FOLLOWUP_CLAIM_CHAPTER).split("\n");
    const pairs = Object.entries(FOLLOWUP_OUTCOMES).flatMap(([run, outcomes]) =>
      Object.keys(outcomes).map((o) => `| \`${o}\` | \`${run}\` |`),
    );
    expect(pairs.filter((p) => !rows.some((r) => r.startsWith(p)))).toEqual([]);
  });
});

describe("forge claims: takeover, launch and merge-ready", () => {
  // Enumerated from the registry and the tables on their own, not through the chapter.
  const claims = Object.keys(FORGE_CLAIM_FIELDS);
  const kinds = claims.map((name) => RECORD_KINDS.find((k) => k.name === name));
  const fields = Object.entries(FORGE_CLAIM_FIELDS).flatMap(([claim, f]) =>
    Object.keys(f).map((name) => [claim, name]),
  );
  const closed = Object.entries(LAUNCH_CLAIM_VALUES).flatMap(([field, v]) =>
    Object.keys(v).map((value) => `${field}.${value}`),
  );
  const values = FORGE_CLAIMS_CHAPTER.values();
  const of = (kind: string) =>
    values.filter((v) => v.kind === kind).map((v) => [v.claim, v.name]);

  test("renders each claim's kind and markers, every field of each claim and every closed value, and nothing else", () => {
    expect(kinds.every((k) => k?.medium === "forge")).toBe(true);
    expect(of("record")).toEqual(claims.map((c) => [c, c]));
    expect(of("marker")).toEqual(
      kinds.flatMap((k) => (k?.markers ?? []).map((m) => [k?.name, m])),
    );
    expect(of("field")).toEqual(fields);
    expect(of("value")).toEqual(
      closed.map((v) => ["dispatch-launch-claim", v]),
    );
    expect(values).toHaveLength(
      ["record", "marker", "field", "value"].reduce(
        (n, k) => n + of(k).length,
        0,
      ),
    );
    expect(FORGE_CLAIMS_CHAPTER.excluded).toEqual([]);
  });

  test("keeps a value's identity apart from its kind, so a withdrawal to a tombstone stays representable", () => {
    expect(FORGE_CLAIMS_CHAPTER.fields.kind?.identifies).toBe(false);
    const identities = values.map((v) => JSON.stringify([v.claim, v.name]));
    expect(new Set(identities).size).toBe(identities.length);
  });

  test("carries each kind's meaning, version and key as the registry holds them", () => {
    for (const k of kinds)
      expect(
        values.find((v) => v.kind === "record" && v.name === k?.name),
      ).toMatchObject({
        meaning: k?.meaning,
        version: k?.version,
        key: k?.key?.source ?? null,
      });
  });

  test("shows each kind, each field with its claim and each closed value with its field in its own section", () => {
    const [kindSection, valueSection, fieldSection] =
      FORGE_CLAIMS_CHAPTER.sections.map((s) => s.render());
    const missing = (text: string | undefined, rows: readonly string[]) =>
      rows.filter((r) => !(text ?? "").includes(`\n${r}`));
    expect(
      missing(
        kindSection,
        claims.map((c) => `| \`${c}\` |`),
      ),
    ).toEqual([]);
    expect(
      missing(
        fieldSection,
        fields.map(([claim, name]) => `| \`${claim}\` | \`${name}\` |`),
      ),
    ).toEqual([]);
    expect(
      missing(
        valueSection,
        closed.map((v) => {
          const at = v.lastIndexOf(".");
          return `| \`${v.slice(0, at)}\` | \`${v.slice(at + 1)}\` |`;
        }),
      ),
    ).toEqual([]);
  });
});

describe("addresses and the verbs of jig send", () => {
  // Enumerated from the two tables on their own, not through the chapter.
  const stations = Object.keys(STATIONS);
  const verbs = Object.keys(SEND_VERBS);
  const values = ADDRESSES.values();
  const of = (kind: string) =>
    values.filter((v) => v.kind === kind).map((v) => String(v.name));

  test("renders every station and every verb, in the tables' order, and nothing else", () => {
    expect(of("station")).toEqual(stations);
    expect(of("verb")).toEqual(verbs);
    expect(values).toHaveLength(stations.length + verbs.length);
    expect(ADDRESSES.excluded).toEqual([]);
  });

  test("carries each verb's stations, person flag and arguments as the table holds them", () => {
    for (const [name, spec] of Object.entries(SEND_VERBS)) {
      const v = values.find((x) => x.kind === "verb" && x.name === name);
      expect(v).toMatchObject({
        stations: spec.stations.join(", "),
        person: spec.person,
        args: spec.args === "" ? null : spec.args,
      });
    }
    for (const [name, spec] of Object.entries(STATIONS))
      expect(
        values.find((x) => x.kind === "station" && x.name === name)?.key,
      ).toBe(spec.key);
  });

  test("shows every station in the stations section and every verb in the verbs section", () => {
    // Each section on its own: a station also appears in the verbs table's
    // To column, and the verb drive shares its name with the station.
    const [stationsSection, verbsSection] = ADDRESSES.sections.map((s) =>
      s.render(),
    );
    const missing = (text: string | undefined, names: readonly string[]) =>
      names.filter((n) => !(text ?? "").includes(`\n| \`${n}\` |`));
    expect(missing(stationsSection, stations)).toEqual([]);
    expect(missing(verbsSection, verbs)).toEqual([]);
  });
});

describe("tracker facets", () => {
  // Enumerated from the tables on their own, not through the chapter.
  const facets = Object.keys(FACET_TABLE);
  const priorities = ["none", ...Object.keys(PRIORITIES)];
  const stores = Object.keys(FACET_STORES);
  const table: AdapterStoreCells = ADAPTER_FACET_STORES;
  const cells = Object.entries(table).flatMap(([adapter, byFacet]) =>
    Object.entries(byFacet).flatMap(([facet, byStore]) =>
      Object.entries(byStore).map(([store, v]) => ({
        name: `${adapter}:${facet}:${store}`,
        ...v,
      })),
    ),
  );
  const reasons = Object.keys(FACET_STORE_REASONS);
  const values = TRACKER_FACETS.values();
  const of = (kind: string) =>
    values.filter((v) => v.kind === kind).map((v) => String(v.name));

  test("renders every facet, priority, store, adapter's store and reason, in the tables' order, and nothing else", () => {
    expect(of("facet")).toEqual(facets);
    expect(of("priority")).toEqual(priorities);
    expect(of("store")).toEqual(stores);
    expect(of("adapter-store")).toEqual(cells.map((c) => c.name));
    expect(of("reason")).toEqual(reasons);
    expect(values).toHaveLength(
      facets.length +
        priorities.length +
        stores.length +
        cells.length +
        reasons.length,
    );
    expect(TRACKER_FACETS.excluded).toEqual([]);
  });

  test("carries each priority's number and whether each adapter holds each store, as the tables hold them", () => {
    for (const [name, spec] of Object.entries(PRIORITIES))
      expect(
        values.find((v) => v.kind === "priority" && v.name === name)?.number,
      ).toBe(spec.number);
    for (const cell of cells)
      expect(
        values.find((v) => v.kind === "adapter-store" && v.name === cell.name),
      ).toMatchObject({ held: cell.held, meaning: cell.meaning });
  });

  test("shows each table's entries in its own section", () => {
    const [facetSection, prioritySection, storeSection, , reasonSection] =
      TRACKER_FACETS.sections.map((s) => s.render());
    const missing = (text: string | undefined, names: readonly string[]) =>
      names.filter((n) => !(text ?? "").includes(`\n| \`${n}\` |`));
    expect(missing(facetSection, facets)).toEqual([]);
    // A priority's row opens with its number, then its configuration name.
    for (const [name, spec] of Object.entries(PRIORITIES))
      expect(prioritySection).toContain(`\n| ${spec.number} | \`${name}\` |`);
    expect(missing(storeSection, stores)).toEqual([]);
    expect(missing(reasonSection, reasons)).toEqual([]);
  });

  test("shows a row per adapter and facet, with a cell per store, refused where the adapter does not hold it", () => {
    const section = TRACKER_FACETS.sections[3]?.render() ?? "";
    const rows = section.split("\n").slice(2);
    expect(rows).toHaveLength(cells.length / stores.length);
    const refused = cells.filter((c) => !c.held).length;
    expect(section.split("| refused: ").length - 1).toBe(refused);
    // Each row's cells are the source entry's, in the order of the stores.
    for (const [adapter, byFacet] of Object.entries(table))
      for (const [facet, byStore] of Object.entries(byFacet)) {
        const row = rows.filter((r) =>
          r.includes(`(\`${adapter}\`) | \`${facet}\` |`),
        );
        expect(row).toHaveLength(1);
        const rendered = (row[0] ?? "").split(" | ").slice(2);
        const expected = stores.map((s) => byStore[s]);
        expect(rendered).toHaveLength(expected.length);
        expected.forEach((hold, i) => {
          const text = (rendered[i] ?? "").replace(/^\s+|[\s|]+$/g, "");
          expect(text.startsWith("refused: ")).toBe(!hold?.held);
          expect(text).toContain((hold?.meaning ?? "").replaceAll("<", "&lt;"));
        });
      }
  });
});
