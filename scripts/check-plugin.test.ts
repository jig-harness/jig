import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
