/**
 * The repository is the `jig` plugin for Claude Code and Codex. These
 * tests pin its manifests and run the shipped skill scripts the way a plugin
 * cache holds them: copied outside this repository (no `node_modules`
 * anywhere above them), invoked from a scratch consumer repository whose own
 * configuration, triage bands and sibling skill they must find.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../plugin/shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { writeWorkingArtifact } from "./artifact.ts";
import {
  claudeMarketplace,
  claudeUserInstall,
  codexInstall,
  codexMarketplace,
  DEFAULT_SOURCE,
  describeSource,
  followsMain,
  PLUGIN_ID,
  parse,
  sameSource,
} from "./setup.ts";

const root = resolve(import.meta.dirname, "../..");
const skill = "resolve-review-comments";
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !LEAKY_GIT_ENV.some((name) => name === key.toUpperCase()),
  ),
);
delete env.JIG_OVERLAY;
delete env.JIG_REVIEW_TRIAGE_CONFIG;
delete env.JIG_CONSUMER_ROOT;

function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), "utf8"));
}

let scratch: string;
let scripts: string;
let shared: string;
beforeAll(() => {
  // The real path a script finds: links resolved, 8.3 short names expanded.
  scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "jig-plugin-")));
  // The plugin cache holds the plugin as the release channels ship it
  // (skills, shared code, agents, assets, manifests), without its tests and
  // its instructions for agents working on Jig itself.
  writeWorkingArtifact(root, join(scratch, "artifact"));
  renameSync(join(scratch, "artifact", "plugin"), join(scratch, "cache"));
  scripts = join(scratch, "cache", "skills", skill, "scripts");
  shared = join(scratch, "cache", "shared");
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("change-note commands run from the plugin cache and read the repository's configuration", () => {
  const consumer = join(scratch, "changelog-consumer");
  mkdirSync(join(consumer, "changes"), { recursive: true });
  mkdirSync(join(consumer, ".config"), { recursive: true });
  writeFileSync(join(consumer, "package.json"), '{"version":"1.0.0"}\n');
  writeFileSync(
    join(consumer, "CHANGELOG.md"),
    "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-01-01\n",
  );
  writeFileSync(
    join(consumer, "changes", "entry.md"),
    "---\nrelease: patch\n---\n\n### Fixed\n\n- Repair the example.\n",
  );
  const commands = join(scratch, "cache", "skills", "changelog", "scripts");
  const run = (command: string, flags: string[]) =>
    spawnSync(process.execPath, [join(commands, command), ...flags], {
      cwd: consumer,
      env,
    });
  // Without the field in the repository's own file nothing is asked of it.
  for (const command of ["check.ts", "lint.ts", "release.ts", "status.ts"]) {
    const off = run(command, []);
    expectSpawnExit({ ...off, exitCode: off.status }, 0);
    expect(off.stdout).toContain("not configured");
  }
  writeFileSync(
    join(consumer, ".config", "jig.yaml"),
    "changelog:\n  file: CHANGELOG.md\n",
  );
  const check = run("check.ts", ["--base", "HEAD"]);
  // The consumer is not a git repository, so there is nothing to compare with.
  expectSpawnExit({ ...check, exitCode: check.status }, 1);
  expect(check.stderr).toContain("cannot be compared with HEAD");
  const release = run("release.ts", ["--dry-run", "--json"]);
  expectSpawnExit({ ...release, exitCode: release.status }, 0);
  expect(JSON.parse(release.stdout).version).toBe("1.0.1");
  expect(readFileSync(join(consumer, "package.json"), "utf8")).toContain(
    "1.0.0",
  );
  expect(existsSync(join(consumer, "changes", "entry.md"))).toBe(true);
  const status = run("status.ts", ["--json"]);
  expectSpawnExit({ ...status, exitCode: status.status }, 0);
  expect(JSON.parse(status.stdout).next).toBe("1.0.1");
  // The changelog names no versioning scheme and links no version.
  const lint = run("lint.ts", ["--json"]);
  expectSpawnExit({ ...lint, exitCode: lint.status }, 1);
  expect(JSON.parse(lint.stdout)).toMatchObject({
    format: "keep-a-changelog",
    file: "CHANGELOG.md",
  });
  expect(
    JSON.parse(lint.stdout).findings.map((f: { rule: string }) => f.rule),
  ).toContain("keep-a-changelog/version-link");
  for (const command of ["check.ts", "lint.ts", "release.ts", "status.ts"]) {
    const unknown = run(command, ["--unknown"]);
    expectSpawnExit({ ...unknown, exitCode: unknown.status }, 2);
  }
  writeFileSync(
    join(consumer, ".config", "jig.yaml"),
    "changelog:\n  file: MISSING.md\n",
  );
  const unreadable = run("release.ts", []);
  expectSpawnExit({ ...unreadable, exitCode: unreadable.status }, 2);
  expect(unreadable.stderr).toContain("MISSING.md does not exist");
  const unlinted = run("lint.ts", []);
  expectSpawnExit({ ...unlinted, exitCode: unlinted.status }, 2);
  expect(unlinted.stderr).toContain("MISSING.md does not exist");
});

/**
 * The relative specifiers `file` imports at run time (static, side-effect,
 * re-export, dynamic and `require`), as Bun's own parser reads them, so a
 * specifier counts exactly when Bun would load it. That parser erases
 * type-only imports; the compiler checks those in shared code (below). A
 * script's `#!` line, which the scanner rejects, is blanked first.
 */
function relativeImports(text: string, file = "source.ts"): string[] {
  const loader = file.endsWith(".mjs") ? "js" : "ts";
  return new Bun.Transpiler({ loader })
    .scanImports(text.replace(/^#!.*/, ""))
    .map((entry) => entry.path)
    .filter((path) => /^\.{1,2}\//.test(path));
}

/** One relative import per line, in every run-time form, with the traps between. */
const SCANNER_SOURCE = [
  'import { a } from "./a.ts";',
  'export { f } from "./f.ts";',
  'export * from "./h.ts";',
  'import "../skills/drive-pr/scripts/drive.ts";',
  'const i = await import("./i.ts");',
  "const j = await import(`../skills/drive-pr/scripts/j.ts`);",
  'const r = require("./r.ts");',
  'let n = 1; const ratio = n++ / 2; await import("./after-division.ts");',
  'import "\\u002e/escaped.ts";',
  "await import(`\\u002e/escaped-template.ts`);",
  'await import(("./parenthesized.ts"));',
  'require(("./parenthesized-require.ts"));',
  "const u = /[\"'`/]{/;\nimport './after-regex.ts';",
  "// import './commented.ts';",
  'const s = "import \\"./in-string.ts\\"";',
  'const y = import.meta.dir; obj.require("./not-y.ts");',
  'import { e } from "node:fs";',
  "a; e; i; j; r; ratio; s; u; y;",
].join("\n");

const SCANNER_FOUND = [
  "./a.ts",
  "./f.ts",
  "./h.ts",
  "../skills/drive-pr/scripts/drive.ts",
  "./i.ts",
  "../skills/drive-pr/scripts/j.ts",
  "./r.ts",
  "./after-division.ts",
  "./escaped.ts",
  "./escaped-template.ts",
  "./parenthesized.ts",
  "./parenthesized-require.ts",
  "./after-regex.ts",
];

test("the import scanner sees every run-time form of relative import", () => {
  expect(relativeImports(SCANNER_SOURCE).toSorted()).toEqual(
    SCANNER_FOUND.toSorted(),
  );
});

test("every relative import in the copied plugin resolves inside the copy", () => {
  // A skill reaches shared code by relative path, so the copy must hold it;
  // shared code never reaches into a skill, so a skill can be removed or
  // renamed without breaking the others.
  const cache = join(scratch, "cache");
  const unresolved: string[] = [];
  const intoSkills: string[] = [];
  const files = readdirSync(cache, { recursive: true, encoding: "utf8" })
    .filter((path) => /\.(ts|mts|mjs)$/.test(path))
    .map((path) => join(cache, path));
  expect(files.some((path) => path.startsWith(join(cache, "shared")))).toBe(
    true,
  );
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const path of relativeImports(text, file)) {
      const target = resolve(dirname(file), path);
      const where = `${file.slice(cache.length + 1)} -> ${path}`;
      if (!target.startsWith(cache) || !existsSync(target))
        unresolved.push(where);
      if (
        file.startsWith(join(cache, "shared")) &&
        target.startsWith(join(cache, "skills"))
      )
        intoSkills.push(where);
    }
  }
  expect(unresolved).toEqual([]);
  expect(intoSkills).toEqual([]);
});

/**
 * Type-checks `dir/shared` with no `skills/` beside it. The include names no
 * extension, so the compiler takes every file kind it reads (`.ts`, `.mts`,
 * `.cts`, declaration files), and declaration files are checked rather than
 * skipped, so an import in any of them must resolve.
 */
function compileSharedAlone(dir: string): {
  status: number | null;
  output: string;
} {
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: join(root, "tsconfig.json"),
      compilerOptions: {
        typeRoots: [join(root, "node_modules", "@types")],
        skipLibCheck: false,
      },
      include: ["shared/**/*"],
      exclude: [],
    }),
  );
  const tsc = spawnSync(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", dir],
    { cwd: dir, env },
  );
  return { status: tsc.status, output: `${tsc.stdout}${tsc.stderr}` };
}

test("shared code compiles with no skill beside it, type imports included", () => {
  // The compiler resolves every form an import can take, type-only ones
  // too, so with skills/ absent any import of a skill fails to resolve.
  const alone = join(scratch, "shared-alone");
  cpSync(shared, join(alone, "shared"), { recursive: true });
  expect(compileSharedAlone(alone)).toEqual({ status: 0, output: "" });
  // One type-only import of a skill in each file kind shared code can hold.
  const leaks = [
    "leak.ts",
    "leak-module.mts",
    "leak-common.cts",
    "leak-types.d.ts",
  ];
  for (const [index, name] of leaks.entries())
    writeFileSync(
      join(alone, "shared", name),
      `import type * as Drive from "\\u002e./skills/drive-pr/scripts/drive.ts";\nexport type Leak${index} = typeof Drive;\n`,
    );
  const leak = compileSharedAlone(alone);
  expect(leak.status).not.toBe(0);
  for (const name of leaks) expect(leak.output).toContain(`shared/${name}(1,`);
  expect(leak.output.match(/TS2307/g)?.length).toBe(leaks.length);
});

test("every shipped skill is named after its directory and avoids repository paths", () => {
  const skills = readdirSync(join(root, "plugin", "skills"), {
    withFileTypes: true,
  }).filter((entry) => entry.isDirectory());
  expect(skills.length).toBeGreaterThan(0);
  for (const entry of skills) {
    const text = readFileSync(
      join(root, "plugin", "skills", entry.name, "SKILL.md"),
      "utf8",
    );
    expect(text).toMatch(new RegExp(`^---\\nname: ${entry.name}\\n`));
    // Installed once per machine: scripts are reached through the skill's own
    // directory, never through a path inside the consumer repository.
    expect(text).not.toContain(`.claude/skills/${entry.name}`);
    expect(text).not.toContain("{{");
  }
});

test("the plugin serves the drive loop's skills and agent from both manifests", () => {
  const claude = json("plugin/.claude-plugin/plugin.json");
  const codex = json("plugin/.codex-plugin/plugin.json");
  const skills = ["drive-pr", "do-item", "resolve-review-comments"];
  const agents = readdirSync(join(root, "plugin", "agents"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length));
  expect(agents).toContain("review-arbiter");
  for (const name of skills)
    expect(existsSync(join(root, "plugin", "skills", name, "SKILL.md"))).toBe(
      true,
    );
  // Both tools load every skills/<name>/SKILL.md through "./skills/". Claude
  // Code loads agents/ by default and an `agents` key would replace that
  // scan; Codex plugins carry no agents (see plugin/README.md).
  expect(claude.agents).toBeUndefined();
  expect(codex.agents).toBeUndefined();
  for (const manifest of [claude, codex])
    for (const name of [...skills, ...agents])
      expect(String(manifest.description)).toContain(name);
});

test("every shipped agent is named after its file and inherits the session's model", () => {
  const dir = join(root, "plugin", "agents");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".md"))) {
    const text = readFileSync(join(dir, file), "utf8");
    const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
    expect(frontmatter).toMatch(
      new RegExp(`^name: ${file.slice(0, -".md".length)}$`, "m"),
    );
    expect(frontmatter).toMatch(/^description: \S/m);
    // Model routing is the consumer's choice, so the agent runs on the
    // invoking session's model; Claude Code ignores hooks, mcpServers and
    // permissionMode in plugin agents, so declaring them would only mislead.
    for (const field of ["model", "hooks", "mcpServers", "permissionMode"])
      expect(frontmatter).not.toMatch(new RegExp(`^${field}:`, "m"));
  }
});

test("setup defaults to the Jig repository and rejects unknown flags", () => {
  const previous = process.env.JIG_MARKETPLACE;
  delete process.env.JIG_MARKETPLACE;
  try {
    expect(parse([])).toEqual({
      check: false,
      source: DEFAULT_SOURCE,
      explicit: false,
      defaulted: true,
      only: null,
    });
    expect(parse(["--check", "--codex", "--source", "/x"])).toEqual({
      check: true,
      source: "/x",
      explicit: true,
      defaulted: false,
      only: "codex",
    });
    expect(parse(["--channel", "latest"])).toEqual({
      check: false,
      source: `${DEFAULT_SOURCE}#latest`,
      explicit: true,
      defaulted: false,
      only: null,
    });
    expect(() => parse(["--source"])).toThrow("needs a marketplace source");
    expect(() => parse(["--bogus"])).toThrow("unknown argument");
    expect(() => parse(["--channel", "beta"])).toThrow(
      "--channel needs one of: latest, stable",
    );
    expect(() =>
      parse(["--channel", "stable", "--source", `${DEFAULT_SOURCE}#v0.3.0`]),
    ).toThrow("contradict each other");
    expect(() =>
      parse(["--channel", "stable", "--source", "/src/jig"]),
    ).toThrow("has no channels");
  } finally {
    if (previous !== undefined) process.env.JIG_MARKETPLACE = previous;
  }
});

test("setup reads only the user-scope Claude Code install", () => {
  // `claude plugin list --json` lists one entry per scope; a project install
  // made for another directory must neither satisfy nor fail the check.
  const project = {
    id: PLUGIN_ID,
    scope: "project",
    projectPath: "/elsewhere",
    version: "0.1.0",
    enabled: false,
  };
  const user = {
    id: PLUGIN_ID,
    scope: "user",
    version: "0.2.0",
    enabled: true,
  };
  expect(claudeUserInstall([project])).toBeNull();
  expect(claudeUserInstall([project, user])).toEqual({
    version: "0.2.0",
    enabled: true,
  });
  expect(claudeUserInstall({ unexpected: true })).toBeNull();
  expect(
    codexInstall({
      installed: [{ pluginId: PLUGIN_ID, version: "0.2.0", enabled: false }],
    }),
  ).toEqual({ version: "0.2.0", enabled: false });
  expect(codexInstall({ installed: [] })).toBeNull();
});

test("setup recognises where a marketplace is registered from", () => {
  expect(
    claudeMarketplace([
      {
        name: "jig",
        source: "git",
        url: "https://github.com/jig-harness/jig.git",
        ref: "v0.2.0",
      },
    ]),
  ).toEqual({
    location: "https://github.com/jig-harness/jig.git#v0.2.0",
    git: true,
  });
  expect(
    claudeMarketplace([{ name: "jig", source: "directory", path: "/src/jig" }]),
  ).toEqual({ location: "/src/jig", git: false });
  expect(
    codexMarketplace({
      marketplaces: [
        {
          name: "jig",
          marketplaceSource: { sourceType: "git", source: DEFAULT_SOURCE },
        },
      ],
    }),
  ).toEqual({ location: DEFAULT_SOURCE, git: true });
  // Codex's list leaves the ref out; its config.toml carries it.
  expect(
    codexMarketplace(
      {
        marketplaces: [
          {
            name: "jig",
            marketplaceSource: { sourceType: "git", source: DEFAULT_SOURCE },
          },
        ],
      },
      { marketplaces: { jig: { source: DEFAULT_SOURCE, ref: "stable" } } },
    ),
  ).toEqual({ location: `${DEFAULT_SOURCE}#stable`, git: true });
  expect(codexMarketplace({ marketplaces: [] })).toBeNull();
  expect(
    describeSource({ location: `${DEFAULT_SOURCE}#stable`, git: true }),
  ).toBe("the stable channel");
  expect(describeSource({ location: DEFAULT_SOURCE, git: true })).toBe(
    "main, the source address",
  );
  expect(
    describeSource({ location: `${DEFAULT_SOURCE}#v0.3.0`, git: true }),
  ).toBe("v0.3.0, pinned");
  // Naming main outright still follows main; only a version tag is a pin.
  expect(
    describeSource({ location: `${DEFAULT_SOURCE}#main`, git: true }),
  ).toBe("main, the source address");
  expect(
    describeSource({ location: `${DEFAULT_SOURCE}#feature`, git: true }),
  ).toBe("the ref feature");
  expect(followsMain(undefined)).toBe(true);
  expect(followsMain("main")).toBe(true);
  expect(followsMain("refs/heads/main")).toBe(true);
  expect(followsMain("stable")).toBe(false);
  expect(describeSource({ location: "/src/jig", git: false })).toBe(
    "the directory /src/jig",
  );
  // A channel is a ref: following one channel does not satisfy the other.
  expect(
    sameSource(`${DEFAULT_SOURCE}#latest`, `${DEFAULT_SOURCE}#stable`),
  ).toBe(false);
  expect(sameSource(`${DEFAULT_SOURCE}#v0.2.0`, DEFAULT_SOURCE)).toBe(true);
  // A requested release must not be satisfied by an unpinned registration.
  expect(sameSource(DEFAULT_SOURCE, `${DEFAULT_SOURCE}#v0.2.0`)).toBe(false);
  expect(sameSource("https://github.com/jig-harness/jig", DEFAULT_SOURCE)).toBe(
    true,
  );
  expect(
    sameSource(`${DEFAULT_SOURCE}#v0.1.0`, `${DEFAULT_SOURCE}#v0.2.0`),
  ).toBe(false);
  expect(sameSource("/src/jig", DEFAULT_SOURCE)).toBe(false);
});

/**
 * Run setup.ts against stub `claude`/`codex` commands that log every call and
 * answer the list queries from STUB_* environment JSON.
 */
function runSetup(
  args: string[],
  stub: Record<string, string>,
): { status: number | null; stdout: string; stderr: string; calls: string[] } {
  const bin = mkdtempSync(join(scratch, "stub-bin-"));
  const log = join(bin, "calls.log");
  for (const tool of ["claude", "codex"])
    writeFileSync(
      join(bin, tool),
      `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(tool)} + " " + args + "\\n");
const key = ("STUB_${tool}_" + args).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
if (process.env.STUB_SLEEP === args) await Bun.sleep(10_000);
if (process.env[key] !== undefined) console.log(process.env[key]);
`,
      { mode: 0o755 },
    );
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "setup.ts"), ...args],
    {
      env: {
        ...env,
        // Never the machine's own Codex configuration.
        CODEX_HOME: join(scratch, "no-codex-home"),
        ...stub,
        JIG_MARKETPLACE: "",
        PATH: `${bin}${delimiter}${dirname(process.execPath)}${delimiter}/usr/bin${delimiter}/bin`,
      },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n")
    : [];
  return { ...result, calls };
}

const registeredHere = JSON.stringify([
  { name: "jig", source: "directory", path: "/src/jig" },
]);
const userInstall = JSON.stringify([
  { id: PLUGIN_ID, scope: "user", version: "0.2.0", enabled: true },
]);

test.skipIf(process.platform === "win32")(
  "setup refuses a conflicting source before changing anything",
  () => {
    const result = runSetup(["--claude", "--source", DEFAULT_SOURCE], {
      STUB_CLAUDE_PLUGIN_MARKETPLACE_LIST_JSON: registeredHere,
      STUB_CLAUDE_PLUGIN_LIST_JSON: userInstall,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is registered from /src/jig");
    expect(result.calls).toEqual([
      "claude --version",
      "claude plugin marketplace list --json",
    ]);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup updates the user-scope install and refreshes a Git Codex marketplace",
  () => {
    const result = runSetup([], {
      STUB_CLAUDE_PLUGIN_MARKETPLACE_LIST_JSON: registeredHere,
      STUB_CLAUDE_PLUGIN_LIST_JSON: userInstall,
      STUB_CODEX_PLUGIN_MARKETPLACE_LIST_JSON: JSON.stringify({
        marketplaces: [
          {
            name: "jig",
            marketplaceSource: { sourceType: "git", source: DEFAULT_SOURCE },
          },
        ],
      }),
      STUB_CODEX_PLUGIN_LIST_JSON: JSON.stringify({
        installed: [{ pluginId: PLUGIN_ID, version: "0.2.0", enabled: true }],
      }),
    });
    expect(result.status).toBe(0);
    expect(result.calls).toContain("claude plugin update jig@jig --scope user");
    expect(result.calls).not.toContain("claude plugin update jig@jig");
    const codex = result.calls.filter((call) =>
      call.startsWith("codex plugin"),
    );
    expect(codex).toEqual([
      "codex plugin marketplace list --json",
      "codex plugin marketplace upgrade jig",
      "codex plugin add jig@jig",
      "codex plugin list --json",
      "codex plugin marketplace list --json",
    ]);
    // A machine registered from main is told how to follow a channel.
    expect(result.stderr).toContain(
      "codex: jig@jig follows main, the source address",
    );
    expect(result.stdout).toContain(
      "codex: jig@jig 0.2.0 enabled, following main, the source address",
    );
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup installs a fresh machine at the channel asked for",
  () => {
    const result = runSetup(["--channel", "latest"], {
      STUB_CLAUDE_PLUGIN_MARKETPLACE_LIST_JSON: "[]",
      STUB_CODEX_PLUGIN_MARKETPLACE_LIST_JSON: '{"marketplaces":[]}',
      STUB_CLAUDE_PLUGIN_LIST_JSON: userInstall,
      STUB_CODEX_PLUGIN_LIST_JSON: JSON.stringify({
        installed: [{ pluginId: PLUGIN_ID, version: "0.2.0", enabled: true }],
      }),
    });
    expect(result.status).toBe(0);
    expect(result.calls).toContain(
      `claude plugin install jig --marketplace ${DEFAULT_SOURCE}#latest`,
    );
    expect(result.calls).toContain(
      `codex plugin marketplace add ${DEFAULT_SOURCE} --ref latest`,
    );
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup refuses to move a machine to another channel without the removal",
  () => {
    const codexHome = mkdtempSync(join(scratch, "codex-home-"));
    writeFileSync(
      join(codexHome, "config.toml"),
      `[marketplaces.jig]\nsource_type = "git"\nsource = "${DEFAULT_SOURCE}"\nref = "latest"\n`,
    );
    const result = runSetup(["--codex", "--channel", "stable"], {
      STUB_CODEX_PLUGIN_MARKETPLACE_LIST_JSON: JSON.stringify({
        marketplaces: [
          {
            name: "jig",
            marketplaceSource: { sourceType: "git", source: DEFAULT_SOURCE },
          },
        ],
      }),
      CODEX_HOME: codexHome,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `registered from ${DEFAULT_SOURCE}#latest, not ${DEFAULT_SOURCE}#stable`,
    );
    expect(result.stderr).toContain("codex plugin marketplace remove jig");
    expect(result.calls).toEqual([
      "codex --version",
      "codex plugin marketplace list --json",
    ]);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup bounds a stalled tool command",
  () => {
    const result = runSetup(["--claude"], {
      STUB_CLAUDE_PLUGIN_MARKETPLACE_LIST_JSON: registeredHere,
      STUB_SLEEP: "plugin marketplace update jig",
      JIG_SETUP_TIMEOUT_SECONDS: "1",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("did not finish within 1s");
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "setup never skips a tool it could not inspect",
  () => {
    // A stalled version probe is an error, not "not on PATH": --check must
    // not pass for the other tool alone.
    const result = runSetup(["--check"], {
      STUB_SLEEP: "--version",
      JIG_SETUP_TIMEOUT_SECONDS: "1",
      STUB_CODEX_PLUGIN_LIST_JSON: JSON.stringify({
        installed: [{ pluginId: PLUGIN_ID, version: "0.2.0", enabled: true }],
      }),
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("claude --version did not finish");
    expect(result.stdout).not.toContain("not on PATH");
  },
  30_000,
);

/** A scratch consumer repository holding only its own configuration. */
function consumerRepo(name: string, overlay?: string): string {
  const consumer = join(scratch, name);
  mkdirSync(consumer);
  const git = spawnSync("git", ["init", "-q", consumer], { env });
  expectSpawnExit({ ...git, exitCode: git.status }, 0);
  if (overlay !== undefined) {
    mkdirSync(join(consumer, ".config"));
    writeFileSync(join(consumer, ".config", "jig.yaml"), overlay);
  }
  return consumer;
}

const overlay = `# Read at run time from the repository the agent works in.
gates:
  command: bun run gates
review:
  bots: ["review-bot[bot]"]
  job_pattern: custom-review-job
  required_checks: [custom-review-job]
  deferral_team: TASK
issue_tracker:
  team: TASK
surfaces: { ignored: true }
`;

test("the configuration step reads the consumer's YAML from any directory in it", () => {
  const consumer = consumerRepo("config", overlay);
  const nested = join(consumer, "src", "deep");
  mkdirSync(nested, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [join(scripts, "consumer-config.ts")],
    { cwd: nested, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...result, exitCode: result.status }, 0);
  expect(result.stdout).toContain(`repository: ${consumer}\n`);
  expect(result.stdout).toContain("gates.command: bun run gates\n");
  expect(result.stdout).toContain("review.job_pattern: custom-review-job\n");
  expect(result.stdout).toContain("review.deferral_team: TASK\n");
});

test("an explicit consumer root and a dangling sibling link are honoured", () => {
  const consumer = consumerRepo("explicit-root", overlay);
  const elsewhere = consumerRepo("elsewhere");
  const result = spawnSync(
    process.execPath,
    [join(scripts, "consumer-config.ts")],
    {
      cwd: elsewhere,
      env: { ...env, JIG_CONSUMER_ROOT: consumer },
      encoding: "utf8",
    },
  );
  expectSpawnExit({ ...result, exitCode: result.status }, 0);
  expect(result.stdout).toContain(`repository: ${consumer}\n`);
  // A broken drive-pr link is a broken integration, not an absent sibling:
  // it must be returned so its use fails visibly.
  mkdirSync(join(consumer, ".claude", "skills"), { recursive: true });
  symlinkSync(
    join(consumer, "missing-target"),
    join(consumer, ".claude", "skills", "drive-pr"),
  );
  const probe = join(consumer, "sibling-probe.ts");
  writeFileSync(
    probe,
    `import { siblingSkill } from ${JSON.stringify(join(shared, "consumer.ts"))}; console.log(siblingSkill("drive-pr", ${JSON.stringify(scripts)}));\n`,
  );
  const sibling = spawnSync(process.execPath, [probe], {
    cwd: consumer,
    env,
    encoding: "utf8",
  });
  expectSpawnExit({ ...sibling, exitCode: sibling.status }, 0);
  expect(sibling.stdout.trim()).toBe(
    join(consumer, ".claude", "skills", "drive-pr"),
  );
  // A dangling ancestor says nothing about the intended sibling either.
  const danglingParent = consumerRepo("dangling-parent", overlay);
  mkdirSync(join(danglingParent, ".claude"));
  symlinkSync(
    join(danglingParent, "moved-skills"),
    join(danglingParent, ".claude", "skills"),
  );
  const viaParent = spawnSync(
    process.execPath,
    [
      "-e",
      `import { siblingSkill } from ${JSON.stringify(join(shared, "consumer.ts"))}; console.log(siblingSkill("drive-pr", ${JSON.stringify(scripts)}));`,
    ],
    { cwd: danglingParent, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...viaParent, exitCode: viaParent.status }, 0);
  expect(viaParent.stdout.trim()).toBe(
    join(danglingParent, ".claude", "skills", "drive-pr"),
  );
  // A repository without .claude at all is a confirmed absence.
  const plain = consumerRepo("no-claude-dir", overlay);
  const fallback = spawnSync(
    process.execPath,
    [
      "-e",
      `import { siblingSkill } from ${JSON.stringify(join(shared, "consumer.ts"))}; console.log(siblingSkill("drive-pr", ${JSON.stringify(scripts)}));`,
    ],
    { cwd: plain, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...fallback, exitCode: fallback.status }, 0);
  expect(fallback.stdout.trim()).toBe(
    join(dirname(dirname(scripts)), "drive-pr"),
  );
  // An unreadable skills directory is indeterminate, not absence.
  if (process.platform !== "win32" && process.getuid?.() !== 0) {
    const locked = consumerRepo("locked-skills", overlay);
    const skills = join(locked, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    chmodSync(skills, 0o000);
    try {
      const result = spawnSync(
        process.execPath,
        [
          "-e",
          `import { siblingSkill } from ${JSON.stringify(join(shared, "consumer.ts"))}; console.log(siblingSkill("drive-pr", ${JSON.stringify(scripts)}));`,
        ],
        { cwd: locked, env, encoding: "utf8" },
      );
      expectSpawnExit({ ...result, exitCode: result.status }, 0);
      expect(result.stdout.trim()).toBe(join(skills, "drive-pr"));
    } finally {
      chmodSync(skills, 0o755);
    }
  }
});

test("an unconfigured repository is refused, not run with guessed values", () => {
  const consumer = consumerRepo("unconfigured");
  const result = spawnSync(
    process.execPath,
    [join(scripts, "consumer-config.ts")],
    { cwd: consumer, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...result, exitCode: result.status }, 2);
  expect(result.stderr).toContain("Jig configuration not found");
  expect(result.stderr).toContain(".config/jig.yaml");
  const partial = consumerRepo("partial", "review:\n  job_pattern: null\n");
  const refused = spawnSync(
    process.execPath,
    [join(scripts, "consumer-config.ts")],
    { cwd: partial, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...refused, exitCode: refused.status }, 2);
  expect(refused.stderr).toContain(
    "lacks required values: gates.command, review.bots, review.deferral_team",
  );
  // Reviewer selection the wait step would refuse is refused up front, with
  // the wait step's own message (one shared validator).
  for (const [name, edit, message] of [
    [
      "uncovered",
      (text: string) =>
        text.replace("  required_checks: [custom-review-job]\n", ""),
      "requires review.required_checks",
    ],
    [
      "blank-pattern",
      (text: string) =>
        text
          .replace("job_pattern: custom-review-job", 'job_pattern: " "')
          .replace("  required_checks: [custom-review-job]\n", ""),
      "requires review.required_checks",
    ],
    [
      "invalid-pattern",
      (text: string) =>
        text.replace("job_pattern: custom-review-job", 'job_pattern: "["'),
      "is not a valid regular expression",
    ],
    [
      "excluded-check",
      (text: string) =>
        text.replace(
          "required_checks: [custom-review-job]",
          "required_checks: [other-check]",
        ),
      "required check 'other-check' is excluded",
    ],
    [
      "blank-bot",
      (text: string) =>
        text.replace('bots: ["review-bot[bot]"]', 'bots: ["  "]'),
      "review.bots must be a list of nonempty reviewer names",
    ],
  ] as const) {
    const repo = consumerRepo(name, edit(overlay));
    const early = spawnSync(
      process.execPath,
      [join(scripts, "consumer-config.ts")],
      { cwd: repo, env, encoding: "utf8" },
    );
    expectSpawnExit({ ...early, exitCode: early.status }, 2);
    expect(early.stderr).toContain(message);
  }
});

test("plugin scripts use consumer policy and the consumer's sibling skill", () => {
  const consumer = consumerRepo("policy", overlay);
  const configDir = join(consumer, ".config");
  cpSync(
    join(
      root,
      "plugin",
      "skills",
      skill,
      "__tests__/fixtures/review-triage.yaml",
    ),
    join(configDir, "review-triage.yaml"),
  );
  // A consumer sibling provides its CLI; the plugin deliberately lacks it.
  const driver = join(consumer, ".claude/skills/drive-pr/scripts");
  mkdirSync(driver, { recursive: true });
  writeFileSync(join(driver, "drive-state.ts"), "console.log('7');\n");
  writeFileSync(
    join(driver, "assert-post-allowed.ts"),
    "console.error('consumer fence'); process.exitCode = 11;\n",
  );
  // The reply's liveness read runs before the consumer fence, so it needs an
  // open PR to reach the fence this test asserts on.
  const bin = join(consumer, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bun
const id = process.argv.find(arg => arg.startsWith("threadId="))?.slice(9);
console.log(JSON.stringify({ data: { node: { __typename: "PullRequestReviewThread", id, pullRequest: { number: 42, state: "OPEN" } } } }));
`,
    { mode: 0o755 },
  );
  const childEnv = { ...env, PATH: `${bin}${delimiter}${process.env.PATH}` };
  const round = spawnSync(
    process.execPath,
    [join(scripts, "current-round.ts"), "42"],
    { cwd: consumer, env: childEnv, encoding: "utf8" },
  );
  expectSpawnExit({ ...round, exitCode: round.status }, 0);
  expect(round.stdout.trim()).toBe("7");
  const ghBin = join(consumer, "stub-bin");
  mkdirSync(ghBin);
  writeFileSync(
    join(ghBin, "gh"),
    `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'checks') console.log('[]');
else if (args[0] === 'api') console.log('HTTP/2.0 200 OK\\r\\n\\r\\n' + JSON.stringify({state:'open',head:{sha:'a'.repeat(40)}}));
else process.exitCode = 1;
`,
  );
  chmodSync(join(ghBin, "gh"), 0o755);
  if (process.platform !== "win32") {
    // The required check comes from the consumer's YAML configuration.
    const requiredAwait = spawnSync(
      process.execPath,
      [
        join(scripts, "await-round.ts"),
        "42",
        "--once",
        "--no-ci",
        "--no-count",
      ],
      {
        cwd: consumer,
        env: { ...childEnv, PATH: `${ghBin}${delimiter}${childEnv.PATH}` },
        encoding: "utf8",
      },
    );
    expectSpawnExit({ ...requiredAwait, exitCode: requiredAwait.status }, 4);
    expect(requiredAwait.stderr).toContain(
      "required reviewer coverage is incomplete",
    );
  }
  const invalidAwait = spawnSync(
    process.execPath,
    [join(scripts, "await-round.ts"), "--invalid-flag"],
    { cwd: consumer, env: childEnv, encoding: "utf8", input: "" },
  );
  expectSpawnExit({ ...invalidAwait, exitCode: invalidAwait.status }, 2);
  expect(invalidAwait.stderr).toContain("unknown flag: --invalid-flag");
  // The stub gh above is a shebang script, which Windows cannot execute, so
  // the liveness read ahead of the fence is only reachable on POSIX.
  if (process.platform !== "win32") {
    const post = spawnSync(
      process.execPath,
      [join(scripts, "reply-to-thread.ts"), "PRRT_test"],
      {
        cwd: consumer,
        env: { ...childEnv, DRIVE_PR_TARGET: "42" },
        encoding: "utf8",
        input: "**accepted** Added the guard.\n",
      },
    );
    expectSpawnExit({ ...post, exitCode: post.status }, 11);
    expect(post.stderr).toContain("consumer fence");
  }
  const probe = join(consumer, "probe.ts");
  writeFileSync(
    probe,
    `import { defaultConfigPath, loadLadder } from ${JSON.stringify(join(scripts, "lib/ladder.ts"))}; const loaded = await loadLadder(defaultConfigPath()); console.log(JSON.stringify({path: defaultConfigPath(), valid: loaded.config !== null, anomaly: loaded.anomaly}));\n`,
  );
  const ladder = spawnSync(process.execPath, ["--no-install", probe], {
    cwd: consumer,
    env: childEnv,
    encoding: "utf8",
  });
  expectSpawnExit({ ...ladder, exitCode: ladder.status }, 0);
  expect(JSON.parse(ladder.stdout)).toEqual({
    path: join(configDir, "review-triage.yaml"),
    valid: true,
    anomaly: "",
  });
  // The vendored parser keeps js-yaml's refusal of duplicated keys.
  const configPath = join(configDir, "review-triage.yaml");
  writeFileSync(
    configPath,
    `${readFileSync(configPath, "utf8")}\nversion: 1\n`,
  );
  const duplicate = spawnSync(process.execPath, ["--no-install", probe], {
    cwd: consumer,
    env: childEnv,
    encoding: "utf8",
  });
  expectSpawnExit({ ...duplicate, exitCode: duplicate.status }, 0);
  const rejected = JSON.parse(duplicate.stdout);
  expect(rejected.valid).toBe(false);
  expect(rejected.anomaly).toContain("duplicated mapping key");
});

test("the procedure skills read the consumer's values from a plugin copy", () => {
  const consumer = consumerRepo(
    "procedure",
    `adr:
  directory: records/decisions
fix_ci:
  regenerate_commands: ["bun run generate"]
`,
  );
  mkdirSync(join(consumer, "records", "decisions"), { recursive: true });
  writeFileSync(
    join(consumer, "records", "decisions", "ADR-0007-cache.md"),
    "# ADR-0007\n",
  );
  writeFileSync(join(consumer, "bun.lock"), "");
  const cache = join(scratch, "cache", "skills");
  const run = (script: string) =>
    spawnSync(process.execPath, [join(cache, script)], {
      cwd: consumer,
      env,
      encoding: "utf8",
    });

  const adr = run("adr/scripts/locate.ts");
  expectSpawnExit({ ...adr, exitCode: adr.status }, 0);
  expect(JSON.parse(adr.stdout)).toMatchObject({
    directory: "records/decisions",
    next: "0008",
  });

  const fixCi = run("fix-ci/scripts/consumer-config.ts");
  expectSpawnExit({ ...fixCi, exitCode: fixCi.status }, 0);
  expect(fixCi.stdout).toContain("package_manager: bun (from bun.lock)\n");
  expect(fixCi.stdout).toContain("  - bun run generate\n");
});

test("code-stats runs from the plugin copy and reads the consumer's code_stats", () => {
  const consumer = consumerRepo(
    "code-stats",
    `code_stats:
  areas:
    - name: product
      paths: ["app/**"]
  default_area: leftover
`,
  );
  writeFileSync(join(consumer, "README.md"), "# Shop\n");
  mkdirSync(join(consumer, "app"));
  writeFileSync(join(consumer, "app", "main.ts"), "export const x = 1;\n");
  const add = spawnSync("git", ["-C", consumer, "add", "-A"], { env });
  expectSpawnExit({ ...add, exitCode: add.status }, 0);
  const run = spawnSync(
    process.execPath,
    [
      join(
        scratch,
        "cache",
        "skills",
        "code-stats",
        "scripts",
        "code-stats.ts",
      ),
      "--json",
    ],
    { cwd: consumer, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...run, exitCode: run.status }, 0);
  const report = JSON.parse(run.stdout) as {
    byArea: Record<string, { files: number }>;
  };
  expect(Object.keys(report.byArea)).toEqual(["product", "leftover"]);
  expect(report.byArea.product?.files).toBe(1);
});

test("file-issue lints and validates against the consumer's configured taxonomy from the plugin copy", () => {
  const consumer = consumerRepo(
    "file-issue",
    "issue_tracker:\n  team: TASK\n  taxonomy: docs/labels.yaml\n",
  );
  mkdirSync(join(consumer, "docs"));
  writeFileSync(
    join(consumer, "docs", "labels.yaml"),
    `version: 1
types: [{id: feature}, {id: bug}]
statuses: [{id: todo}, {id: done}]
groups:
  - {id: size, required: true, labels: [{id: small}, {id: large}]}
categories:
  - {id: area, prefix: "area:", labels: [{id: api}]}
`,
  );
  const scripts = join(scratch, "cache", "skills", "file-issue", "scripts");
  const run = (script: string, args: string[]) =>
    spawnSync(process.execPath, [join(scripts, script), ...args], {
      cwd: join(consumer, "docs"),
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const lint = run("check-label-taxonomy.ts", []);
  expectSpawnExit({ ...lint, exitCode: lint.status }, 0);
  expect(lint.stdout).toContain("groups=1, categories=1");
  const valid = run("validate-labels.ts", ["feature", "small", "area:api"]);
  expectSpawnExit({ ...valid, exitCode: valid.status }, 0);
  const invalid = run("validate-labels.ts", ["feature", "small", "large"]);
  expectSpawnExit({ ...invalid, exitCode: invalid.status }, 3);
});

test("change-areas resolves and checks the consumer's catalog from the plugin copy", () => {
  const consumer = consumerRepo(
    "change-areas",
    `drive:
  change_areas_catalog: .config/change-areas.yaml
`,
  );
  writeFileSync(
    join(consumer, ".config", "change-areas.yaml"),
    `vocabularies:
  category: [service, docs]
  deployTier: [primary, none]
profiles:
  shallow: { localChecks: ["true"], verificationChecks: ["true"] }
  deep: { localChecks: ["make test"], verificationChecks: ["make test"] }
areas:
  api:
    title: API
    category: service
    paths: ["src/**"]
    workspace: ["src"]
    impliedBy: [docs]
    deployTier: primary
    review: { skills: [api-review] }
  docs:
    title: Docs
    category: docs
    paths: ["docs/**", ".config/**"]
    workspace: []
    impliedBy: []
    deployTier: none
    validation: { profile: shallow }
`,
  );
  mkdirSync(join(consumer, "src"));
  writeFileSync(join(consumer, "src", "main.ts"), "export const x = 1;\n");
  mkdirSync(join(consumer, "docs"));
  writeFileSync(join(consumer, "docs", "guide.md"), "# Guide\n");
  const scriptsDir = join(
    scratch,
    "cache",
    "skills",
    "change-areas",
    "scripts",
  );

  const resolved = spawnSync(
    process.execPath,
    [join(scriptsDir, "resolve.ts"), "--files", "-", "--format", "json"],
    { cwd: consumer, env, encoding: "utf8", input: "docs/guide.md\n" },
  );
  expectSpawnExit({ ...resolved, exitCode: resolved.status }, 0);
  expect(JSON.parse(resolved.stdout)).toMatchObject({
    seedAreas: ["docs"],
    areas: ["api", "docs"],
    reviewSkills: ["api-review"],
    validation: { profiles: ["shallow"] },
  });

  const checked = spawnSync(process.execPath, [join(scriptsDir, "check.ts")], {
    cwd: consumer,
    env,
    encoding: "utf8",
  });
  expectSpawnExit({ ...checked, exitCode: checked.status }, 0);
});

test("one change-area catalog reader serves the skills from the plugin copy", () => {
  const consumer = consumerRepo(
    "catalog",
    `issue_tracker:
  team: TASK
do_item:
  agents:
    codearea_areas: { "codearea:api": api }
    catalog: { backend: Backend Agent }
drive:
  change_areas_catalog: .config/change-areas.yaml
`,
  );
  writeFileSync(
    join(consumer, ".config", "change-areas.yaml"),
    `areas:
  api:
    paths: ["src/{api,rpc}/**"]
    agent: backend
    linear:
      labels: [area:api]
      flags: [security]
`,
  );
  const cache = join(scratch, "cache", "skills");
  const agent = spawnSync(
    process.execPath,
    [join(cache, "do-item", "scripts", "determine_agent.ts"), "-"],
    {
      cwd: consumer,
      env,
      encoding: "utf8",
      input: '{"labels":["codearea:api"],"title":"x"}',
    },
  );
  expectSpawnExit({ ...agent, exitCode: agent.status }, 0);
  expect(JSON.parse(agent.stdout)).toMatchObject({
    primary_agent: "Backend Agent",
  });

  const probe = join(consumer, "catalog-probe.ts");
  writeFileSync(
    probe,
    `import { areasOf, loadCatalogFile } from ${JSON.stringify(join(cache, "drive-pr", "scripts", "lib", "change-areas-catalog.ts"))};
const c = loadCatalogFile(".config/change-areas.yaml");
console.log(JSON.stringify({ areas: areasOf("src/rpc/x.ts", c), flags: c.get("api")?.flags }));
`,
  );
  const read = spawnSync(process.execPath, [probe], {
    cwd: consumer,
    env,
    encoding: "utf8",
  });
  expectSpawnExit({ ...read, exitCode: read.status }, 0);
  expect(JSON.parse(read.stdout)).toEqual({
    areas: ["api"],
    flags: ["security"],
  });

  // Every skill matches paths through that module: no second glob compiler.
  const definitions = spawnSync(
    "git",
    ["grep", "-l", "-F", "function globToRegExp(", "--", "plugin/"],
    { cwd: root, env, encoding: "utf8" },
  );
  expect(definitions.stdout.trim().split("\n")).toEqual([
    "plugin/skills/drive-pr/scripts/lib/change-areas-catalog.ts",
  ]);
});

test("work-batch's eligibility mode reads the consumer's labels and catalog from the plugin copy", () => {
  const consumer = consumerRepo(
    "work-batch",
    `issue_tracker:
  labels:
    hitl: needs-human
do_item:
  agents:
    codearea_areas: { "area:api": api, "area:web": web }
drive:
  change_areas_catalog: .config/change-areas.yaml
work_batch:
  solo_flags: [privacy-review]
`,
  );
  writeFileSync(
    join(consumer, ".config", "change-areas.yaml"),
    `areas:
  api:
    paths: ["src/api/**"]
    tracker:
      labels: [area:api]
      flags: [contract-review]
  web:
    paths: ["src/web/**"]
    tracker:
      labels: [area:web]
`,
  );
  const issue = (identifier: string, labels: string[]) => ({
    identifier,
    title: identifier,
    url: null,
    priority: 3,
    createdAt: "2026-01-01T00:00:00Z",
    state: { id: "s", name: "Backlog", type: "backlog" },
    assignee: null,
    labels,
    hasOpenChildren: false,
    truncated: [],
  });
  const run = spawnSync(
    process.execPath,
    [
      join(
        scratch,
        "cache",
        "skills",
        "work-batch",
        "scripts",
        "candidates.ts",
      ),
      "--eligibility",
    ],
    {
      cwd: consumer,
      env,
      encoding: "utf8",
      input: JSON.stringify([
        issue("TASK-1", ["small", "area:web"]),
        issue("TASK-2", ["small", "area:api", "contract-review"]),
        issue("TASK-3", ["small", "area:web", "needs-human:legal"]),
        issue("TASK-4", ["small", "area:api"]),
      ]),
    },
  );
  expectSpawnExit({ ...run, exitCode: run.status }, 0);
  const report = JSON.parse(run.stdout);
  expect(report.policy.soloFlags).toEqual([
    "contract-review",
    "manual-ops",
    "needs-human",
    "privacy-review",
  ]);
  expect(report.verdicts.map((v: { eligible: boolean }) => v.eligible)).toEqual(
    [true, false, false, false],
  );
  expect(report.verdicts[3].reason.kind).toBe("solo-area");
});

test("the audit reads its schema, criteria and version from the plugin copy", () => {
  const consumer = consumerRepo("audit", "gates:\n  comand: make check\n");
  const commit = spawnSync(
    "git",
    [
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "start",
    ],
    { cwd: consumer, env, encoding: "utf8" },
  );
  expectSpawnExit({ ...commit, exitCode: commit.status }, 0);
  const scripts = join(scratch, "cache", "skills", "audit", "scripts");
  const run = (script: string, ...args: string[]) =>
    spawnSync(process.execPath, [join(scripts, script), ...args], {
      cwd: consumer,
      env,
      encoding: "utf8",
    });

  const fit = run("config-fit.ts", "--offline", "--json");
  expect(
    (JSON.parse(fit.stdout) as { findings: { id: string }[] }).findings.map(
      (f) => f.id,
    ),
  ).toContain("unknown:gates.comand");

  const check = run("score.ts", "--check");
  expectSpawnExit({ ...check, exitCode: check.status }, 0);

  const draft = join(scratch, "audit-draft.yaml");
  const write = run("score.ts", "--draft", draft);
  expectSpawnExit({ ...write, exitCode: write.status }, 0);
  const version = json("plugin/.claude-plugin/plugin.json").version;
  expect(readFileSync(draft, "utf8")).toContain(`plugin_version: ${version}\n`);
});

test("the sheet skills run from the plugin copy and share one sheet kit", () => {
  const cache = join(scratch, "cache", "skills");
  // One kit, in the decide skill; explain reaches it through its sibling.
  expect(
    existsSync(join(cache, "decide", "scripts", "sheet-kit", "html.ts")),
  ).toBe(true);
  expect(existsSync(join(cache, "explain", "scripts", "sheet-kit"))).toBe(
    false,
  );
  const consumer = consumerRepo(
    "sheets",
    "adr:\n  directory: docs/decisions\ndecide:\n  policy_files: [CLAUDE.md]\n",
  );
  mkdirSync(join(consumer, "docs", "decisions"), { recursive: true });
  writeFileSync(
    join(consumer, "docs", "decisions", "ADR-0001-cache-eviction.md"),
    "# ADR-0001: Cache eviction\nThe catalogue cache evicts by age.\n",
  );
  writeFileSync(join(consumer, "CLAUDE.md"), "## Caching\nCache reads only.\n");
  const run = (args: string[]) =>
    spawnSync(process.execPath, args, {
      cwd: consumer,
      env,
      encoding: "utf8",
    });

  const precedent = run([
    join(cache, "decide", "scripts", "resolve-precedent.ts"),
    "cache eviction by age",
    "--json",
  ]);
  expectSpawnExit({ ...precedent, exitCode: precedent.status }, 0);
  const report = JSON.parse(precedent.stdout);
  expect(report.sources.adrDirectory).toBe("docs/decisions");
  expect(report.sources.policyFiles).toEqual(["CLAUDE.md"]);
  expect(report.candidates[0].file).toBe(
    "docs/decisions/ADR-0001-cache-eviction.md",
  );

  const trigger = run([
    join(cache, "decide", "scripts", "decision-sheet", "decision-sheet.ts"),
    "trigger",
    "--facets",
    "technical,product",
    "--options",
    "2",
  ]);
  expectSpawnExit({ ...trigger, exitCode: trigger.status }, 0);
  expect(JSON.parse(trigger.stdout).sheet).toBe(true);

  const source = join(consumer, "explainer.json");
  writeFileSync(
    source,
    JSON.stringify({
      schema: "explainer-sheet/v1",
      id: "cache-reads",
      title: "How the catalogue cache is read",
      verifiedAt: { date: "2026-10-04", commit: "abcdef1" },
      summary: "Reads go through the cache.",
      scope: { covers: ["Cache reads"] },
      sections: [
        {
          id: "reads",
          title: "Reads",
          claims: [{ text: "The cache evicts by age.", source: "CLAUDE.md" }],
        },
      ],
    }),
  );
  const out = join(consumer, "out");
  const render = run([
    join(cache, "explain", "scripts", "explainer-sheet", "explainer-sheet.ts"),
    "render",
    source,
    "--out",
    out,
  ]);
  expectSpawnExit({ ...render, exitCode: render.status }, 0);
  const sheet = readFileSync(join(out, "cache-reads-explainer.html"), "utf8");
  expect(sheet.startsWith("<!doctype html>")).toBe(true);
  expect(sheet).toContain("The cache evicts by age.");
});

test("the plugin carries no dependency outside its own directory", () => {
  // Nothing above the copied plugin provides node_modules, so a script that
  // still imported a package would have failed in the tests above; keep the
  // premise itself checked.
  let dir = dirname(scripts);
  for (;;) {
    expect(existsSync(join(dir, "node_modules"))).toBe(false);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
});

test.skipIf(process.platform === "win32")(
  "plugin thread writers check pull request liveness before every write",
  () => {
    const consumer = consumerRepo("liveness", overlay);
    const bin = join(consumer, "bin");
    mkdirSync(bin);
    const log = join(consumer, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      `#!/usr/bin/env bun
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const query = args.find(arg => arg.startsWith("query=")) ?? "";
if (query.includes("node(id:$threadId)")) {
  appendFileSync(process.env.TEST_GH_LOG!, "read\\n");
  if (process.env.TEST_PR_STATE === "unreadable") process.exit(1);
  const id = args.find(arg => arg.startsWith("threadId="))?.slice(9);
  console.log(JSON.stringify({ data: { node: { __typename: "PullRequestReviewThread", id, pullRequest: { number: 42, state: process.env.TEST_PR_STATE } } } }));
} else {
  if (args.includes("--input")) readFileSync(0);
  appendFileSync(process.env.TEST_GH_LOG!, "write\\n");
  console.log("true");
}
`,
      { mode: 0o755 },
    );
    const childEnv: Record<string, string | undefined> = {
      ...env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      TEST_GH_LOG: log,
    };
    delete childEnv.DRIVE_PR_TARGET;
    for (const script of [
      "reply-to-thread.ts",
      "resolve-thread.ts",
      "unresolve-thread.ts",
    ]) {
      for (const state of ["OPEN", "MERGED", "CLOSED", "unreadable"]) {
        writeFileSync(log, "");
        const result = spawnSync(
          process.execPath,
          [join(scripts, script), "PRRT_plugin"],
          {
            cwd: consumer,
            env: { ...childEnv, TEST_PR_STATE: state },
            encoding: "utf8",
            input: "**accepted** Added the guard.\n",
            timeout: 5000,
          },
        );
        expectSpawnExit(
          { ...result, exitCode: result.status },
          state === "OPEN" ? 0 : state === "unreadable" ? 1 : 5,
        );
        expect(readFileSync(log, "utf8")).toBe(
          state === "OPEN" ? "read\nwrite\n" : "read\n",
        );
      }
    }
  },
  30_000,
);

test("the vendored YAML parser is the pinned js-yaml build", () => {
  // The plugin cache has no node_modules, so the plugin ships js-yaml's own
  // ESM build with its licence. CONTRIBUTING.md § Derived files says how to
  // refresh both when the dependency is updated.
  const vendor = join(root, "plugin", "shared", "vendor");
  const pinned = join(root, "node_modules/js-yaml");
  expect(readFileSync(join(vendor, "js-yaml.mjs"), "utf8")).toBe(
    readFileSync(join(pinned, "dist/js-yaml.mjs"), "utf8"),
  );
  expect(readFileSync(join(vendor, "js-yaml.LICENSE"), "utf8")).toBe(
    readFileSync(join(pinned, "LICENSE"), "utf8"),
  );
});

test("plugin cancellation registrations release only their own ownership", () => {
  const probe = join(scratch, "ownership-probe.ts");
  writeFileSync(
    probe,
    `
import { registerCancellationGroup } from ${JSON.stringify(join(shared, "proc.ts"))};
const signals: number[] = [];
process.kill = ((pid: number) => { signals.push(pid); return true; }) as typeof process.kill;
process.on("SIGTERM", () => {});
const cancel = async () => { signals.push(777); return true; };
const register = () => registerCancellationGroup(777, undefined, cancel);
const expected = process.platform === "win32" ? "777" : "-777,-777";
const first = register();
const second = register();
first();
process.emit("SIGTERM");
await new Promise(resolve => setImmediate(resolve));
if (signals.join(",") !== expected) throw Error("one release removed another owner");
second();
signals.length = 0;
process.emit("SIGTERM");
await new Promise(resolve => setImmediate(resolve));
if (signals.length) throw Error("released ownership remained");
const third = register();
first(); second();
process.emit("SIGTERM");
await new Promise(resolve => setImmediate(resolve));
if (signals.join(",") !== expected) throw Error("stale release removed new ownership");
third();
console.log("owned");
`,
  );
  const child = spawnSync(process.execPath, [probe], {
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  expectSpawnExit({ ...child, exitCode: child.status }, 0);
  expect(child.stdout.trim()).toBe("owned");
});

test("the turn-budget hook runs from the plugin copy, where its registration points", () => {
  const cache = join(scratch, "cache");
  const registration = JSON.parse(
    readFileSync(join(cache, "hooks", "hooks.json"), "utf8"),
  ) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
  const command = registration.hooks.PreToolUse[0]?.hooks[0]?.command ?? "";
  const relative =
    /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"]+)"/.exec(command)?.[1] ?? "missing";
  const hook = join(cache, relative);
  expect(existsSync(hook)).toBe(true);
  const dir = mkdtempSync(join(scratch, "turn-budget-"));
  const transcript = join(dir, "transcript.jsonl");
  writeFileSync(
    transcript,
    `${Array.from({ length: 95 }, (_, i) =>
      JSON.stringify({ type: "assistant", requestId: `req_${i}` }),
    ).join("\n")}\n`,
  );
  const result = spawnSync(process.execPath, [hook], {
    cwd: dir,
    env: {
      ...env,
      JIG_TURN_BUDGET: "100",
      JIG_TURN_BUDGET_MARGIN: "10",
      JIG_TURN_BUDGET_STATE_DIR: join(dir, "state"),
    },
    encoding: "utf8",
    input: JSON.stringify({
      session_id: "copy",
      transcript_path: transcript,
      hook_event_name: "PreToolUse",
    }),
    timeout: 10_000,
  });
  expectSpawnExit({ ...result, exitCode: result.status }, 0);
  const context = (
    JSON.parse(result.stdout) as {
      hookSpecificOutput: { additionalContext: string };
    }
  ).hookSpecificOutput.additionalContext;
  expect(context).toContain("about 95 of 100");
  // The wrap-up names the copy's own drive-pr, not this repository's.
  expect(context).toContain(
    join(cache, "skills", "drive-pr", "scripts", "drive-state.ts"),
  );
});
