import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../plugin/shared/guarded-git-spawn.ts";
import { writeWorkingArtifact } from "../tools/plugin/artifact.ts";
import { linkFindings, manifestFindings } from "./check-plugin.ts";

const root = resolve(import.meta.dir, "..");
const FILES = [
  "plugin/.claude-plugin/plugin.json",
  "plugin/.codex-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  ".agents/plugins/marketplace.json",
];

/** The repository's own four files, parsed, for a test to change. */
function files(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    FILES.map((file) => [
      file,
      JSON.parse(readFileSync(join(root, file), "utf8")) as Record<
        string,
        unknown
      >,
    ]),
  );
}

test("the repository's manifests and marketplaces agree", () => {
  expect(manifestFindings(files())).toEqual([]);
});

test("every relative link in the installed plugin's Markdown resolves inside it", () => {
  const out = mkdtempSync(join(tmpdir(), "jig-plugin-links-"));
  try {
    const written = writeWorkingArtifact(root, out);
    expect(linkFindings(out, written)).toEqual([]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a link out of the plugin is a finding, unless it is a URL or in a template", () => {
  const out = mkdtempSync(join(tmpdir(), "jig-plugin-links-"));
  try {
    const docs: Record<string, string> = {
      "plugin/README.md":
        "[g](../GLOSSARY.md) [s](skills/x/SKILL.md#a) [u](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) [h](#here)\n",
      "plugin/skills/x/SKILL.md":
        "[r](../../README.md) [m](../../../mise.toml)\n",
      "plugin/skills/x/templates/t.md": "[c](../../../../CONTRIBUTING.md)\n",
    };
    for (const [path, text] of Object.entries(docs)) {
      mkdirSync(dirname(join(out, path)), { recursive: true });
      writeFileSync(join(out, path), text);
    }
    const found = linkFindings(out, Object.keys(docs)).map(
      (f) => `${f.file}: ${f.problem}`,
    );
    expect(found).toEqual([
      "plugin/README.md: the link to ../GLOSSARY.md resolves to nothing the installed plugin holds",
      "plugin/skills/x/SKILL.md: the link to ../../../mise.toml resolves to nothing the installed plugin holds",
    ]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("every way Markdown spells a link is read, and only links are", () => {
  const out = mkdtempSync(join(tmpdir(), "jig-plugin-links-"));
  try {
    const docs: Record<string, string> = {
      "plugin/README.md": [
        '[c](CONFIGURATION.md "Reference") [a](<CONFIGURATION.md>) [p](<a (b).md>)',
        "`[x](../nope.md)` and ``[y](../nope.md)``",
        "```md",
        "[z](../nope.md)",
        "```",
        "~~~",
        "[w](../nope.md)",
        "~~~",
        "[g](<../GLOSSARY.md>) [r][ref] [m](../.claude-plugin/marketplace.json)",
        "[l](linked/SKILL.md)",
        "",
        '[ref]: ../CONTRIBUTING.md "Contributing"',
        "[ok]: <CONFIGURATION.md>",
        "",
      ].join("\n"),
      "plugin/CONFIGURATION.md": "",
      "plugin/a (b).md": "",
    };
    for (const [path, text] of Object.entries(docs)) {
      mkdirSync(dirname(join(out, path)), { recursive: true });
      writeFileSync(join(out, path), text);
    }
    mkdirSync(join(out, ".claude-plugin"));
    writeFileSync(join(out, ".claude-plugin/marketplace.json"), "{}");
    mkdirSync(join(out, "elsewhere"));
    writeFileSync(join(out, "elsewhere/SKILL.md"), "");
    symlinkSync(join(out, "elsewhere"), join(out, "plugin/linked"));
    const found = linkFindings(out, ["plugin/README.md"]).map(
      (f) => `${f.line}: ${f.problem}`,
    );
    expect(found).toEqual([
      "9: the link to ../GLOSSARY.md resolves to nothing the installed plugin holds",
      "9: the link to ../.claude-plugin/marketplace.json resolves to nothing the installed plugin holds",
      "10: the link to linked/SKILL.md resolves to nothing the installed plugin holds",
      "12: the link to ../CONTRIBUTING.md resolves to nothing the installed plugin holds",
    ]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a manifest that differs from the other in a shared field is a finding", () => {
  const changed = files();
  (
    changed["plugin/.codex-plugin/plugin.json"] as Record<string, unknown>
  ).version = "9.9.9";
  const findings = manifestFindings(changed);
  expect(findings.map((f) => f.problem)).toEqual([
    '"version" differs from plugin/.claude-plugin/plugin.json',
  ]);
  expect(findings[0]?.file).toBe("plugin/.codex-plugin/plugin.json");
});

test("a renamed plugin or marketplace is a finding", () => {
  const changed = files();
  for (const file of [
    "plugin/.claude-plugin/plugin.json",
    "plugin/.codex-plugin/plugin.json",
  ])
    (changed[file] as Record<string, unknown>).name = "jig2";
  (changed[".claude-plugin/marketplace.json"] as Record<string, unknown>).name =
    "jig2";
  const problems = manifestFindings(changed).map(
    (f) => `${f.file}: ${f.problem}`,
  );
  expect(problems).toContain(
    'plugin/.claude-plugin/plugin.json: the plugin is named "jig2", not "jig"',
  );
  expect(problems).toContain(
    'plugin/.codex-plugin/plugin.json: the plugin is named "jig2", not "jig"',
  );
  expect(problems).toContain(
    '.claude-plugin/marketplace.json: the marketplace is named "jig2", not "jig"',
  );
});

test("a marketplace listing another source or a second plugin is a finding", () => {
  const changed = files();
  const codex = changed[".agents/plugins/marketplace.json"] as {
    plugins: Record<string, unknown>[];
  };
  codex.plugins = [{ ...codex.plugins[0], source: "./elsewhere" }];
  const claude = changed[".claude-plugin/marketplace.json"] as {
    plugins: Record<string, unknown>[];
  };
  claude.plugins = [...claude.plugins, { name: "other", source: "./other" }];
  expect(manifestFindings(changed).map((f) => f.file)).toEqual([
    ".claude-plugin/marketplace.json",
    ".agents/plugins/marketplace.json",
  ]);
});

test("a version that is not major.minor.patch is a finding", () => {
  const changed = files();
  for (const file of [
    "plugin/.claude-plugin/plugin.json",
    "plugin/.codex-plugin/plugin.json",
  ])
    (changed[file] as Record<string, unknown>).version = "next";
  expect(manifestFindings(changed).map((f) => f.problem)).toEqual([
    'version "next" is not major.minor.patch',
    'version "next" is not major.minor.patch',
  ]);
});

/**
 * Run the gate in a child whose `PATH` holds a stub `claude` (exiting
 * `stubExit`) or none, beside Bun and git.
 */
function runGate(
  stubExit: number | null,
  env: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const bin = mkdtempSync(join(tmpdir(), "jig-check-plugin-"));
  try {
    if (stubExit !== null)
      writeFileSync(
        join(bin, "claude"),
        `#!/bin/sh\necho "stub validator: $*"\nexit ${stubExit}\n`,
        { mode: 0o755 },
      );
    const git = spawnSync("sh", ["-c", "command -v git"], {
      env: withoutLeakyGitEnv(),
    }).stdout.trim();
    const result = spawnSync(
      process.execPath,
      [join(root, "scripts/check-plugin.ts"), root],
      {
        env: {
          ...withoutLeakyGitEnv(),
          GITHUB_ACTIONS: "",
          JIG_REQUIRE_CLAUDE: "",
          ...env,
          PATH: [bin, dirname(process.execPath), dirname(git)].join(delimiter),
        },
        timeout: 60_000,
      },
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test.skipIf(process.platform === "win32")(
  "without claude the validator is skipped, unless JIG_REQUIRE_CLAUDE=1",
  () => {
    const skipped = runGate(null);
    expectSpawnExit({ ...skipped, exitCode: skipped.status }, 0);
    expect(skipped.stderr).toContain("claude is not on PATH");
    const required = runGate(null, { JIG_REQUIRE_CLAUDE: "1" });
    expectSpawnExit({ ...required, exitCode: required.status }, 2);
    expect(required.stderr).toContain("JIG_REQUIRE_CLAUDE=1 demands");
  },
  60_000,
);

test.skipIf(process.platform === "win32")(
  "a validator that fails on the artifact is a finding",
  () => {
    const failed = runGate(1);
    expectSpawnExit({ ...failed, exitCode: failed.status }, 1);
    expect(failed.stderr).toContain(
      "claude plugin validate --strict fails as installed",
    );
    const passed = runGate(0);
    expectSpawnExit({ ...passed, exitCode: passed.status }, 0);
    expect(passed.stdout).toContain("passes on the artifact");
  },
  60_000,
);
