import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../lib/test-helpers/expect-spawn-exit.ts";
import {
  spawnSync,
  withoutLeakyGitEnv,
} from "../plugin/shared/guarded-git-spawn.ts";
import { manifestFindings } from "./check-plugin.ts";

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
