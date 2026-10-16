import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../../../plugin/shared/guarded-git-spawn.ts";
import {
  compare,
  type Counts,
  loosened,
  measure,
  measuredLoosening,
  parseBiome,
  parseJsonc,
  parseTsc,
  strictness,
  trailers,
  unranked,
} from "./ratchet.ts";

// Every scratch directory is removed after the file's tests, failed ones too.
const scratchDirs: string[] = [];
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

const gate = join(import.meta.dir, "ratchet.ts");
const fixtures = join(import.meta.dir, "fixtures");
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()) &&
      key !== "CI" &&
      key !== "RATCHET_BASE",
  ),
);

function sh(cwd: string, cmd: string, args: string[], extra = {}) {
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...env, ...extra },
    encoding: "utf8",
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const todoCounter = {
  name: "todo",
  format: "grep",
  files: "\\.ts$",
  patterns: { todo: "TODO" },
};
const biomeCounter = {
  name: "biome",
  format: "biome-json",
  command: ["biome", "lint", "--reporter=json", "--max-diagnostics=none", "."],
};
const defaultWiring = {
  counters: [todoCounter],
  configs: [
    { path: "biome.json", kind: "biome" },
    { path: "tsconfig.json", kind: "tsconfig" },
    { path: "tsconfig.ratchet.json", kind: "tsconfig" },
  ],
};
// The scratch repositories have no node_modules; Biome comes from this one.
const toolPath = `${join(import.meta.dir, "..", "..", "..", "..", "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`;

/**
 * A scratch repository with `main` at the base and a `work` branch checked
 * out, measured by one grep counter (`TODO` per file) unless `wiring` says
 * otherwise.
 */
function repo(
  files: Record<string, string>,
  wiring: object = defaultWiring,
): {
  dir: string;
  write: (path: string, text: string) => void;
  commit: (message: string) => void;
  ratchet: (extra?: Record<string, string>) => {
    code: number | null;
    out: string;
  };
} {
  const dir = scratch("ratchet-test-");
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const git = (...args: string[]) => {
    const r = sh(dir, "git", args);
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.out}`);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "ratchet@example.com");
  git("config", "user.name", "ratchet");
  git("config", "commit.gpgsign", "false");
  write("ratchet.json", JSON.stringify(wiring));
  for (const [path, text] of Object.entries(files)) write(path, text);
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  git("checkout", "-q", "-b", "work");
  return {
    dir,
    write,
    commit: (message) => {
      git("add", "-A");
      git("commit", "-q", "-m", message);
    },
    ratchet: (extra = {}) =>
      sh(
        dir,
        process.execPath,
        [gate, "--config", "ratchet.json", "--base", "main"],
        { PATH: toolPath, ...extra },
      ),
  };
}

/**
 * Commit a trailer for every name the failure in `out` asks for, and expect
 * the gate to pass then: each refusal names the waiver that accepts it.
 */
function expectApproved(r: ReturnType<typeof repo>, out: string): void {
  const names = new Set(
    [...out.matchAll(/"Ratchet-Loosen: (\S+): <reason>"/g)].map((m) => m[1]),
  );
  expect(names.size).toBeGreaterThan(0);
  const body = [...names].map((n) => `Ratchet-Loosen: ${n}: asked for`);
  const message = `approve\n\n${body.join("\n")}`;
  const c = sh(r.dir, "git", ["commit", "-q", "--allow-empty", "-m", message]);
  expect(c.code).toBe(0);
  const again = r.ratchet();
  expect(again.out).toContain("LOOSENED with a Ratchet-Loosen trailer");
  expect(again.code).toBe(0);
}

const biome = (level: string) =>
  JSON.stringify({
    linter: {
      rules: { preset: "recommended", suspicious: { noDebugger: level } },
    },
  });
const tsconfig = (flags: Record<string, boolean>) =>
  JSON.stringify({ compilerOptions: { strict: true, ...flags } });

describe("ratchet against the merge base", () => {
  const base = {
    "a.ts": "// TODO one\n// TODO two\n",
    "b.ts": "export {};\n",
    "biome.json": biome("error"),
    "tsconfig.json": tsconfig({ noUnusedLocals: true }),
  };

  test("an unchanged tree passes", () => {
    const r = repo(base);
    expect(r.ratchet()).toMatchObject({ code: 0 });
  });

  test("a count that grows fails and names the file", () => {
    const r = repo(base);
    r.write("b.ts", "// TODO three\n");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("todo todo: 2 → 3");
    expect(out).toContain("b.ts (0 → 1)");
  });

  test("uncommitted changes in the working tree are measured", () => {
    const r = repo(base);
    r.write("a.ts", "// TODO one\n// TODO two\n// TODO three\n");
    expect(r.ratchet().code).toBe(1);
  });

  test("moving findings between files passes", () => {
    const r = repo(base);
    r.write("a.ts", "// TODO one\n");
    r.write("b.ts", "// TODO two\n");
    r.commit("move");
    expect(r.ratchet().code).toBe(0);
  });

  test("bringing a rule to zero passes and asks for promotion", () => {
    const r = repo(base);
    r.write("a.ts", "export {};\n");
    r.commit("fix");
    const { code, out } = r.ratchet();
    expect(code).toBe(0);
    expect(out).toContain("promote to error: todo todo");
  });

  test("lowering a rule's severity fails without a trailer", () => {
    const r = repo(base);
    r.write("biome.json", biome("warn"));
    r.commit("relax");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("rule loosened: biome.json: noDebugger");
  });

  test("lowering a rule's severity passes with a Ratchet-Loosen trailer", () => {
    const r = repo(base);
    r.write("biome.json", biome("off"));
    r.commit(
      "relax\n\nRatchet-Loosen: noDebugger: false positives after upgrade",
    );
    const { code, out } = r.ratchet();
    expect(code).toBe(0);
    expect(out).toContain("LOOSENED with a Ratchet-Loosen trailer");
  });

  test("a trailer without a reason does not count", () => {
    const r = repo(base);
    r.write("biome.json", biome("off"));
    r.commit("relax\n\nRatchet-Loosen: noDebugger:");
    expect(r.ratchet().code).toBe(1);
  });

  test("removing a compiler flag fails", () => {
    const r = repo(base);
    r.write("tsconfig.json", tsconfig({}));
    r.commit("drop flag");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("tsconfig.json: noUnusedLocals");
  });

  test("a missing base is reported and skipped locally, and could not be checked in CI", () => {
    const r = repo(base);
    const local = sh(r.dir, process.execPath, [
      gate,
      "--config",
      "ratchet.json",
      "--base",
      "no-such-branch",
    ]);
    expect(local.code).toBe(0);
    expect(local.out).toContain("comparison skipped");
    const ci = sh(
      r.dir,
      process.execPath,
      [gate, "--config", "ratchet.json", "--base", "no-such-branch"],
      { CI: "true" },
    );
    expect(ci.code).toBe(2);
    expect(ci.out).toContain(
      "ratchet: could not check: cannot find the merge base with no-such-branch; CI needs the base history",
    );
    const annotated = sh(
      r.dir,
      process.execPath,
      [gate, "--config", "ratchet.json", "--base", "no-such-branch"],
      { CI: "true", GITHUB_ACTIONS: "true" },
    );
    expect(annotated.code).toBe(2);
    expect(annotated.out).toContain(
      "::error title=ratchet%3A could not check::cannot find the merge base",
    );
  });

  test("--report prints the counts without a base", () => {
    const r = repo(base);
    const { code, out } = sh(r.dir, process.execPath, [
      gate,
      "--config",
      "ratchet.json",
      "--report",
    ]);
    expect(code).toBe(0);
    expect(out).toMatch(/2\s+todo/);
  });
});

describe("loosening the configuration", () => {
  const debuggerCode = "export function f() {\n  debugger;\n}\n";
  const withBiome = {
    ...defaultWiring,
    counters: [todoCounter, biomeCounter],
  };
  const biomeWarn = JSON.stringify({
    root: true,
    linter: {
      rules: { preset: "recommended", suspicious: { noDebugger: "warn" } },
    },
  });

  test("an override that switches a rule off for some files fails", () => {
    const r = repo(
      { "a.ts": debuggerCode, "biome.json": biomeWarn },
      withBiome,
    );
    const doc = JSON.parse(biomeWarn);
    doc.overrides = [
      {
        includes: ["a.ts"],
        linter: { rules: { suspicious: { noDebugger: "off" } } },
      },
    ];
    r.write("biome.json", JSON.stringify(doc));
    r.commit("override");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("biome noDebugger: 1 → 0 in the base");
    expect(out).toContain('"Ratchet-Loosen: noDebugger: <reason>"');
    expectApproved(r, out);
  });

  test("promoting a ratcheted rule to an error is not a loosening", () => {
    const r = repo(
      { "b.ts": "export {};\n", "biome.json": biomeWarn },
      withBiome,
    );
    r.write(
      "biome.json",
      JSON.stringify({
        root: true,
        linter: {
          rules: { preset: "recommended", suspicious: { noDebugger: "error" } },
        },
      }),
    );
    r.commit("promote");
    expect(r.ratchet().code).toBe(0);
  });

  test("strict: false in a config that extends a strict one fails", () => {
    const r = repo({
      "a.ts": "export {};\n",
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true } }),
      "tsconfig.ratchet.json": JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: { exactOptionalPropertyTypes: true },
      }),
    });
    r.write(
      "tsconfig.ratchet.json",
      JSON.stringify({
        extends: "./tsconfig.json",
        compilerOptions: { exactOptionalPropertyTypes: true, strict: false },
      }),
    );
    r.commit("relax");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("tsconfig.ratchet.json: strictNullChecks");
    expectApproved(r, out);
  });

  test("a trailer outside the message's last paragraph does not count", () => {
    const r = repo({ "biome.json": biome("error") });
    r.write("biome.json", biome("off"));
    r.commit(
      "relax\n\nRatchet-Loosen: noDebugger: upgrade broke it\n\nMore words.",
    );
    expect(r.ratchet().code).toBe(1);
  });

  test("an empty reason does not borrow the next trailer", () => {
    const r = repo({ "biome.json": biome("error") });
    r.write("biome.json", biome("off"));
    r.commit(
      "relax\n\nRatchet-Loosen: noDebugger:\nCo-authored-by: A <a@example.com>",
    );
    expect(r.ratchet().code).toBe(1);
  });

  test("a trailer for one compiler flag does not waive another", () => {
    const r = repo({
      "a.ts": "export {};\n",
      "tsconfig.json": tsconfig({
        noUnusedLocals: true,
        noUncheckedIndexedAccess: true,
      }),
    });
    r.write("tsconfig.json", tsconfig({}));
    r.commit("relax\n\nRatchet-Loosen: noUnusedLocals: asked for");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain(
      "rule loosened: tsconfig.json: noUncheckedIndexedAccess",
    );
  });

  test("an override that switches a rule off where nothing is found yet fails", () => {
    const r = repo({ "a.ts": "export {};\n", "biome.json": biomeWarn });
    const doc = JSON.parse(biomeWarn);
    doc.overrides = [
      {
        includes: ["src/**"],
        linter: { rules: { suspicious: { noDebugger: "off" } } },
      },
    ];
    r.write("biome.json", JSON.stringify(doc));
    r.commit("override");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("biome.json: noDebugger@src/**");
    expect(out).toContain('"Ratchet-Loosen: noDebugger: <reason>"');
  });

  test("excluding files from a plugin's scope fails", () => {
    const plugin = (includes: string[]) =>
      JSON.stringify({
        root: true,
        linter: { rules: { preset: "recommended" } },
        plugins: [{ path: "./p.grit", includes }],
      });
    const r = repo({ "a.ts": "export {};\n", "biome.json": plugin(["**"]) });
    r.write("biome.json", plugin(["**", "!src/**"]));
    r.commit("narrow");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("biome.json: includes[plugin:./p.grit]:!src/**");
    expectApproved(r, out);
  });

  test("removing a configuration file from the ratchet's own wiring fails", () => {
    const r = repo({ "a.ts": "// TODO one\n" });
    r.write(
      "ratchet.json",
      JSON.stringify({
        ...defaultWiring,
        configs: defaultWiring.configs.slice(1),
      }),
    );
    r.commit("drop config");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("ratchet wiring: config biome.json");
    expectApproved(r, out);
  });

  test("narrowing a counter's files in the ratchet's own wiring fails", () => {
    const r = repo({ "a.ts": "// TODO one\n" });
    r.write(
      "ratchet.json",
      JSON.stringify({
        ...defaultWiring,
        counters: [{ ...todoCounter, files: "^none$" }],
      }),
    );
    r.commit("narrow files");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("ratchet wiring: counter todo");
    expectApproved(r, out);
  });

  test("two counters with one name are a configuration error", () => {
    const r = repo({ "a.ts": "// TODO one\n" });
    r.write(
      "ratchet.json",
      JSON.stringify({
        ...defaultWiring,
        counters: [todoCounter, { ...todoCounter, patterns: {} }],
      }),
    );
    const { code, out } = r.ratchet();
    expect(code).toBe(2);
    expect(out).toContain("counter names must be unique: todo");
  });

  test("an established counter the base's own configuration cannot run fails", () => {
    const counter = {
      name: "lint",
      format: "biome-json",
      command: [process.execPath, "check.ts"],
    };
    const r = repo(
      { "check.ts": "process.exit(1);\n" },
      { ...defaultWiring, counters: [counter], support: ["check.ts"] },
    );
    r.write("check.ts", "console.log('{\"diagnostics\":[]}');\n");
    r.commit("the head's check runs");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("lint: the base's own configuration did not run");
    expectApproved(r, out);
  });

  test("removing a pattern from the ratchet's own wiring fails", () => {
    const r = repo({ "a.ts": "// TODO one\n" });
    r.write(
      "ratchet.json",
      JSON.stringify({
        ...defaultWiring,
        counters: [{ ...todoCounter, patterns: {} }],
      }),
    );
    r.commit("drop pattern");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("ratchet wiring: counter todo");
    expectApproved(r, out);
  });

  test("a patterns list that is not a map is a configuration error", () => {
    const r = repo({ "a.ts": "// TODO one\n" });
    r.write(
      "ratchet.json",
      JSON.stringify({
        ...defaultWiring,
        counters: [{ ...todoCounter, patterns: [] }],
      }),
    );
    const { code, out } = r.ratchet();
    expect(code).toBe(2);
    expect(out).toContain("a counter or config entry is malformed");
  });

  test("removing a support path from the ratchet's own wiring fails", () => {
    const wiring = { ...defaultWiring, support: ["tools/grit"] };
    const r = repo({ "tools/grit/p.grit": "language js\n" }, wiring);
    r.write("ratchet.json", JSON.stringify({ ...wiring, support: [] }));
    r.commit("drop support");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("ratchet wiring: support tools/grit");
    expectApproved(r, out);
  });

  test("adding or widening a support path fails", () => {
    const wiring = { ...defaultWiring, support: ["tools/grit"] };
    // Each support change copies a file whose findings grew over the base.
    for (const [support, grown, expected] of [
      [["tools/grit", "a.ts"], "a.ts", "ratchet wiring: support a.ts added"],
      [["tools"], "tools/b.ts", "ratchet wiring: support tools added"],
    ] as const) {
      const r = repo(
        { "a.ts": "// TODO one\n", "tools/grit/p.grit": "language js\n" },
        wiring,
      );
      r.write("ratchet.json", JSON.stringify({ ...wiring, support }));
      r.write(grown, "// TODO one\n// TODO two\n");
      r.commit("copy over the base");
      const { code, out } = r.ratchet();
      expect(code).toBe(1);
      expect(out).toContain(expected);
      expectApproved(r, out);
    }
  });

  test("adding a configuration file over a measured file fails", () => {
    const r = repo({ "a.ts": '"TODO"\n' });
    const configs = [
      ...defaultWiring.configs,
      { path: "a.ts", kind: "fallow" },
    ];
    r.write("ratchet.json", JSON.stringify({ ...defaultWiring, configs }));
    r.write("a.ts", '"TODO TODO"\n');
    r.commit("copy over the base");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("ratchet wiring: config a.ts added");
    expectApproved(r, out);
  });

  test("adding a configuration file the base does not have needs no trailer", () => {
    const r = repo({ "a.ts": "// TODO one\n" });
    const configs = [
      ...defaultWiring.configs,
      { path: ".fallowrc.json", kind: "fallow" },
    ];
    r.write("ratchet.json", JSON.stringify({ ...defaultWiring, configs }));
    r.write(".fallowrc.json", "{}\n");
    r.commit("wire a new configuration");
    const { code, out } = r.ratchet();
    expect(out).not.toContain("ratchet wiring");
    expect(code).toBe(0);
  });

  test("reordering include patterns or overrides fails", () => {
    const off = (includes: string[]) => ({
      includes,
      linter: { rules: { suspicious: { noDebugger: "off" } } },
    });
    const config = (includes: string[], overrides: object[]) =>
      JSON.stringify({
        root: true,
        files: { includes },
        linter: { rules: { suspicious: { noDebugger: "warn" } } },
        overrides,
      });
    const patterns = ["**/*.ts", "!src/**", "src/safe.ts"];
    const r = repo({
      "a.ts": "export {};\n",
      "biome.json": config(patterns, [off(["src/**"]), off(["src/x.ts"])]),
    });
    r.write(
      "biome.json",
      config(
        ["**/*.ts", "src/safe.ts", "!src/**"],
        [off(["src/x.ts"]), off(["src/**"])],
      ),
    );
    r.commit("reorder");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("biome.json: the order of files.includes changed");
    expect(out).toContain("biome.json: the order of overrides changed");
    expectApproved(r, out);
  });

  test("swapping two overrides of the same files fails, however their keys are ordered", () => {
    const override = (enabled: boolean) => ({
      includes: ["src/**"],
      linter: { enabled },
    });
    const respelled = (enabled: boolean) => ({
      linter: { enabled },
      includes: ["src/**"],
    });
    const config = (overrides: object[]) =>
      JSON.stringify({ root: true, overrides });
    for (const spell of [override, respelled]) {
      const r = repo({
        "a.ts": "export {};\n",
        "biome.json": config([override(false), override(true)]),
      });
      r.write("biome.json", config([spell(true), spell(false)]));
      r.commit("swap");
      const { code, out } = r.ratchet();
      expect(code).toBe(1);
      expect(out).toContain("biome.json: the order of overrides changed");
      expectApproved(r, out);
    }
  });

  test("a wiring path outside the repository or not in its plain form is refused", () => {
    for (const path of [
      "tools/grit/../../../plugin/a.ts",
      "./tools/grit",
      "/etc",
      "tools\\grit",
    ]) {
      const wiring = { ...defaultWiring, support: [path] };
      const r = repo({ "a.ts": "export {};\n" });
      r.write("ratchet.json", JSON.stringify(wiring));
      r.commit("escape");
      const { code, out } = r.ratchet();
      expect(code).toBe(2);
      expect(out).toContain("a path must name a place inside the repository");
    }
  });

  test("excluding a directory with nothing found in it yet fails", () => {
    const config = (exclude: string[]) =>
      JSON.stringify({ compilerOptions: { strict: true }, exclude });
    const r = repo({ "a.ts": "export {};\n", "tsconfig.json": config([]) });
    r.write("tsconfig.json", config(["clean/**"]));
    r.commit("exclude");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain(
      "tsconfig.json: a setting the ratchet does not rank changed",
    );
    expect(out).toContain('"Ratchet-Loosen: tsconfig.json: <reason>"');
    expectApproved(r, out);
  });

  test("ignoring paths in fallow fails", () => {
    const wiring = {
      ...defaultWiring,
      configs: [{ path: ".fallowrc.jsonc", kind: "fallow" }],
    };
    const r = repo(
      {
        ".fallowrc.jsonc": JSON.stringify({
          rules: { "unused-files": "error" },
        }),
      },
      wiring,
    );
    r.write(
      ".fallowrc.jsonc",
      JSON.stringify({
        rules: { "unused-files": "error" },
        ignorePatterns: ["plugin/**"],
      }),
    );
    r.commit("ignore");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain(
      ".fallowrc.jsonc: a setting the ratchet does not rank",
    );
    expectApproved(r, out);
  });

  test("switching a Biome group off, or an override's preset, fails", () => {
    const rules = (extra: object) =>
      JSON.stringify({
        root: true,
        linter: { rules: { preset: "all", ...extra } },
      });
    for (const [head, expected] of [
      [
        rules({ security: "off" }),
        "biome.json: a setting the ratchet does not rank",
      ],
      [
        JSON.stringify({
          root: true,
          linter: { rules: { preset: "recommended" } },
        }),
        "biome.json: preset",
      ],
      [
        JSON.stringify({
          root: true,
          linter: { rules: { preset: "all" } },
          overrides: [
            { includes: ["src/**"], linter: { rules: { preset: "none" } } },
          ],
        }),
        "biome.json: preset@src/**",
      ],
    ] as const) {
      const r = repo({ "a.ts": "export {};\n", "biome.json": rules({}) });
      r.write("biome.json", head);
      r.commit("relax");
      const { code, out } = r.ratchet();
      expect(code).toBe(1);
      expect(out).toContain(expected);
      expectApproved(r, out);
    }
  });

  test("tightening a ranked setting alone needs no trailer", () => {
    const r = repo({ "a.ts": "export {};\n", "biome.json": biome("warn") });
    r.write("biome.json", biome("error"));
    r.write("tsconfig.json", tsconfig({ noUnusedLocals: true }));
    r.commit("tighten");
    expect(r.ratchet().code).toBe(0);
  });

  test("a configuration extended from a package is read, and one not found is an error", () => {
    const files = {
      ".gitignore": "node_modules/\n",
      "a.ts": "export {};\n",
      "tsconfig.json": JSON.stringify({ extends: "@shared/tsconfig" }),
    };
    const r = repo(files);
    r.write(
      "node_modules/@shared/tsconfig/tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    r.write(
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: false } }),
    );
    r.commit("replace the shared configuration");
    const { code, out } = r.ratchet();
    expect(code).toBe(1);
    expect(out).toContain("tsconfig.json: strictNullChecks");
    expectApproved(r, out);

    r.write("tsconfig.json", JSON.stringify({ extends: "@missing/tsconfig" }));
    r.commit("a parent that does not exist");
    const missing = r.ratchet();
    expect(missing.code).toBe(2);
    expect(missing.out).toContain('cannot resolve extends "@missing/tsconfig"');
  });

  describe("compiler findings follow the compiler settings' trailers", () => {
    // A stand-in compiler: one finding while noUnusedLocals is on.
    const check = [
      'const c = await Bun.file("tsconfig.json").json();',
      'if (c.compilerOptions.noUnusedLocals) console.log("a.ts(1,1): error TS6133: unused");',
      "",
    ].join("\n");
    const wiring = {
      ...defaultWiring,
      counters: [
        {
          name: "types",
          format: "tsc",
          command: [process.execPath, "check.ts"],
        },
      ],
      support: ["check.ts"],
    };
    const relaxed = (message: string) => {
      const r = repo(
        {
          "check.ts": check,
          "tsconfig.json": JSON.stringify({
            compilerOptions: { noUnusedLocals: true },
          }),
        },
        wiring,
      );
      r.write(
        "tsconfig.json",
        JSON.stringify({ compilerOptions: {}, exclude: ["src/**"] }),
      );
      r.commit(message);
      return r.ratchet();
    };

    test("a trailer for the flag alone leaves an exclusion and the lost findings", () => {
      const { code, out } = relaxed(
        "relax\n\nRatchet-Loosen: noUnusedLocals: asked for",
      );
      expect(code).toBe(1);
      expect(out).toContain("rule loosened: tsconfig.json: a setting");
      expect(out).toContain("rule loosened: types TS6133: 1 → 0");
    });

    test("trailers for every compiler setting accept the lost findings", () => {
      const { code, out } = relaxed(
        "relax\n\nRatchet-Loosen: noUnusedLocals: asked for\nRatchet-Loosen: tsconfig.json: asked for",
      );
      expect(out).toContain(
        "LOOSENED with a Ratchet-Loosen trailer: types TS6133",
      );
      expect(code).toBe(0);
    });
  });
});

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
      "plugin:./p.grit",
      "preset",
    ]);
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
