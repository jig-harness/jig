import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compare,
  measure,
  measuredLoosening,
  parseBiome,
  parseTsc,
  trailers,
  loosened,
  parseJsonc,
  strictness,
  unranked,
  type Counts,
} from "./ratchet.ts";
import { scratch, sh } from "./ratchet-test-support.ts";

const fixtures = join(import.meta.dir, "fixtures");

describe("parsers", () => {
  test("Biome's JSON report: warnings ratcheted, errors counted for loosening only", () => {
    const { ratcheted, all } = parseBiome(
      readFileSync(join(fixtures, "biome-report.json"), "utf8"),
    );
    expect([...ratcheted.keys()].sort()).toEqual([
      "jig/json-parse-cast",
      "suspicious/noEmptyBlockStatements",
    ]);
    expect(
      ratcheted.get("suspicious/noEmptyBlockStatements")?.get("a.ts"),
    ).toBe(2);
    expect(all.get("nursery/noFloatingPromises")?.get("c.ts")).toBe(1);
    expect(all.has("style/useTemplate")).toBe(false);
  });

  test("a Biome report with no diagnostics list is an error, not zero", () => {
    expect(() => parseBiome("{}")).toThrow("no diagnostics list");
  });

  test("compiler output is counted per error code and file", () => {
    const counts = parseTsc(readFileSync(join(fixtures, "tsc.txt"), "utf8"));
    expect(counts.get("TS2379")?.get("src/a.ts")).toBe(2);
    expect(counts.get("TS2375")?.get("src/b.ts")).toBe(1);
  });

  test("a compiler run that fails without naming a file is an error, not zero", () => {
    const tree = scratch("ratchet-tsc-");
    const command = [
      process.execPath,
      "-e",
      "console.log('error TS5058: The specified path does not exist.'); process.exit(1)",
    ];
    expect(() =>
      measure(tree, [{ name: "types", format: "tsc", command }]),
    ).toThrow("failed without findings");
  });

  test("JSONC: comments and trailing commas, strings left intact", () => {
    expect(
      parseJsonc('{ // c\n "a": "x // y,}", /* z */ "b": [1, 2,], }'),
    ).toEqual({ a: "x // y,}", b: [1, 2] });
  });

  test("JSONC: a comment between a trailing comma and its bracket", () => {
    expect(parseJsonc('{"x": 1, /* why */ }')).toEqual({ x: 1 });
    expect(parseJsonc("[1, // why\n]")).toEqual([1]);
  });
});

describe("strictness and trailers", () => {
  const tree = scratch("ratchet-strict-");
  const declared = (kind: "biome" | "fallow", doc: object) => {
    const path = `${kind}-${Math.random().toString(36).slice(2)}.json`;
    writeFileSync(join(tree, path), JSON.stringify(doc));
    return strictness(kind, tree, path) ?? new Map();
  };

  test("a rule that moves to another group keeps its strictness", () => {
    const before = declared("biome", {
      linter: { rules: { nursery: { noFloatingPromises: "error" } } },
    });
    const after = declared("biome", {
      linter: { rules: { suspicious: { noFloatingPromises: "error" } } },
    });
    expect(loosened(before, after)).toEqual([]);
  });

  test("dropping a plugin, the preset or the linter is a loosening", () => {
    const before = declared("biome", {
      linter: { rules: { preset: "recommended" } },
      plugins: [{ path: "./p.grit" }],
    });
    const after = declared("biome", {
      linter: { enabled: false, rules: { preset: "none" } },
    });
    expect(loosened(before, after).sort()).toEqual([
      "linter.enabled",
      "plugin:p.grit",
      "preset",
    ]);
  });

  test("a plugin moved to another directory keeps its strictness", () => {
    const before = declared("biome", {
      plugins: [{ path: "./tools/grit/p.grit", includes: ["**", "!src/**"] }],
    });
    const after = declared("biome", {
      plugins: [
        { path: "./modules/rules/p.grit", includes: ["**", "!src/**"] },
      ],
    });
    expect(loosened(before, after)).toEqual([]);
    const narrowed = declared("biome", {
      plugins: [{ path: "./modules/rules/p.grit", includes: ["!src/**"] }],
    });
    expect(loosened(before, narrowed)).toEqual(["includes[plugin:p.grit]:**"]);
    expect(loosened(before, declared("biome", {}))).toEqual(["plugin:p.grit"]);
  });

  test("two plugins with one file name are refused as ambiguous", () => {
    expect(() =>
      declared("biome", {
        plugins: ["./a/p.grit", { path: "./b/p.grit" }],
      }),
    ).toThrow(
      /plugins "\.\/a\/p\.grit" and "\.\/b\/p\.grit" share the file name p\.grit/,
    );
  });

  test("naming a rule only to switch it off is a loosening", () => {
    const before = declared("fallow", { rules: {} });
    const after = declared("fallow", { rules: { "unused-files": "off" } });
    expect(loosened(before, after)).toEqual(["unused-files"]);
  });

  test("fallow rule severities", () => {
    const before = declared("fallow", { rules: { "unused-files": "error" } });
    const after = declared("fallow", { rules: { "unused-files": "warn" } });
    expect(loosened(before, after)).toEqual(["unused-files"]);
  });

  test("extends resolves as the compiler's own --showConfig does", () => {
    const dir = scratch("ratchet-extends-");
    const write = (path: string, doc: object) =>
      writeFileSync(join(dir, path), JSON.stringify(doc));
    writeFileSync(join(dir, "a.ts"), "export {};\n");
    // A parent reached through two entries, one of them without `.json`.
    write("d.json", {
      compilerOptions: { strict: true, noUnusedLocals: true },
    });
    write("b.json", {
      extends: "./d.json",
      compilerOptions: { strict: false },
    });
    write("c.json", { extends: "./d" });
    write("tsconfig.json", { extends: ["./b.json", "./c"], files: ["a.ts"] });
    const tsc = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "node_modules",
      ".bin",
      "tsc",
    );
    const shown = sh(dir, tsc, ["--showConfig", "-p", "tsconfig.json"]);
    expect(shown.code).toBe(0);
    write("flat.json", {
      compilerOptions: JSON.parse(shown.out).compilerOptions,
    });
    const resolved = strictness("tsconfig", dir, "tsconfig.json");
    expect(resolved).toEqual(strictness("tsconfig", dir, "flat.json"));
    expect(resolved?.get("strictNullChecks")).toBe(1);

    write("x.json", { extends: "./y.json" });
    write("y.json", { extends: "./x" });
    expect(() => strictness("tsconfig", dir, "x.json")).toThrow(
      "extends itself",
    );
  });

  test("a package's tsconfig field resolves as the compiler's --showConfig does", () => {
    const dir = scratch("ratchet-package-");
    const write = (path: string, doc: object) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), JSON.stringify(doc));
    };
    writeFileSync(join(dir, "a.ts"), "export {};\n");
    const pkg = "node_modules/@shared/tsconfig";
    write(`${pkg}/package.json`, {
      name: "@shared/tsconfig",
      tsconfig: "configs/strict.json",
    });
    write(`${pkg}/configs/strict.json`, { compilerOptions: { strict: true } });
    write(`${pkg}/tsconfig.json`, { compilerOptions: { strict: false } });
    write("tsconfig.json", { extends: "@shared/tsconfig", files: ["a.ts"] });
    const tsc = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "node_modules",
      ".bin",
      "tsc",
    );
    const shown = sh(dir, tsc, ["--showConfig", "-p", "tsconfig.json"]);
    expect(shown.code).toBe(0);
    write("flat.json", {
      compilerOptions: JSON.parse(shown.out).compilerOptions,
    });
    const resolved = strictness("tsconfig", dir, "tsconfig.json");
    expect(resolved).toEqual(strictness("tsconfig", dir, "flat.json"));
    expect(resolved?.get("strictNullChecks")).toBe(1);
  });

  test("a file inside a package resolves as the compiler's --showConfig does", () => {
    const dir = scratch("ratchet-package-file-");
    const write = (path: string, doc: object) => {
      mkdirSync(join(dir, path, ".."), { recursive: true });
      writeFileSync(join(dir, path), JSON.stringify(doc));
    };
    writeFileSync(join(dir, "a.ts"), "export {};\n");
    const pkg = "node_modules/@shared/tsconfig";
    write(`${pkg}/package.json`, { name: "@shared/tsconfig" });
    write(`${pkg}/strict.json`, { compilerOptions: { strict: true } });
    write("tsconfig.json", {
      extends: "@shared/tsconfig/strict.json",
      files: ["a.ts"],
    });
    const tsc = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "..",
      "node_modules",
      ".bin",
      "tsc",
    );
    const shown = sh(dir, tsc, ["--showConfig", "-p", "tsconfig.json"]);
    expect(shown.code).toBe(0);
    write("flat.json", {
      compilerOptions: JSON.parse(shown.out).compilerOptions,
    });
    const resolved = strictness("tsconfig", dir, "tsconfig.json");
    expect(resolved).toEqual(strictness("tsconfig", dir, "flat.json"));
    expect(resolved?.get("strictNullChecks")).toBe(1);
  });

  test("a parent's references are not inherited", () => {
    const dir = scratch("ratchet-references-");
    const parent = (ref: string) =>
      writeFileSync(
        join(dir, "base.json"),
        JSON.stringify({ references: [{ path: ref }], include: ["src"] }),
      );
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ extends: "./base.json" }),
    );
    parent("./one");
    const before = unranked("tsconfig", dir, "tsconfig.json");
    parent("./two");
    expect(unranked("tsconfig", dir, "tsconfig.json")).toBe(before);
    expect(before).toContain('"src"');
  });

  test("trailers need a name and a reason on the same line", () => {
    expect([
      ...trailers("noDebugger: upgrade broke it\nbare:\n:no-name\n"),
    ]).toEqual(["noDebugger"]);
  });

  test("a rule that finds less under the head's configuration is measured as loosened", () => {
    const own: Counts = new Map([
      ["nursery/noFloatingPromises", new Map([["a.ts", 2]])],
      ["suspicious/noDebugger", new Map([["a.ts", 1]])],
    ]);
    const underHead: Counts = new Map([
      ["suspicious/noFloatingPromises", new Map([["a.ts", 2]])],
    ]);
    expect(measuredLoosening(own, underHead)).toEqual([
      { rule: "noDebugger", before: 1, after: 0 },
    ]);
  });

  test("compiler counters are promoted as a whole", () => {
    const base = new Map<string, Counts>([
      ["types", new Map([["TS2379", new Map([["a.ts", 1]])]])],
    ]);
    const head = new Map<string, Counts>([["types", new Map()]]);
    expect(compare(base, head, new Set(["types"])).promote).toEqual(["types"]);
  });
});
