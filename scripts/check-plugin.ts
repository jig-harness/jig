// The `jig` plugin as the agent tools install it. Builds the artifact the
// release channels carry (tools/plugin/artifact.ts) from the working tree,
// checks that the two plugin manifests and the two marketplace files describe
// one plugin, and runs Claude Code's own validator, strict, over the
// artifact. Codex has no validator; its files are held to the agreement
// checks. Exit 1 on a finding; 2 when it cannot check: a file is unreadable,
// or `claude` is missing where JIG_REQUIRE_CLAUDE=1 (CI) demands it.
// Without that variable a missing `claude` skips the validator with a warning,
// so a contributor without Claude Code can still run the gates.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import {
  couldNotCheck,
  type Finding,
  reportFindings,
} from "../lib/findings.ts";
import {
  gitEnv,
  MARKETPLACE_FILES,
  PLUGIN_DIR,
  writeWorkingArtifact,
} from "../tools/plugin/artifact.ts";
import { spawnSync } from "../plugin/shared/guarded-git-spawn.ts";

const RULE = "plugin-as-installed";

/** The plugin's and the marketplace's name; never changes (plugin/AGENTS.md). */
export const NAME = "jig";

const CLAUDE_MANIFEST = `${PLUGIN_DIR}/.claude-plugin/plugin.json`;
const CODEX_MANIFEST = `${PLUGIN_DIR}/.codex-plugin/plugin.json`;
const [CLAUDE_MARKETPLACE, CODEX_MARKETPLACE] = MARKETPLACE_FILES;

/** The fields both plugin manifests carry, which must therefore agree. */
export const SHARED_FIELDS = [
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "skills",
] as const;

type Json = Record<string, unknown>;

function finding(file: string, problem: string, remedy: string): Finding {
  return { rule: RULE, file, problem, remedy };
}

/**
 * What is wrong with the manifests and marketplace files, read from `files`
 * (path → parsed JSON): both manifests named `jig` with every shared field
 * equal, and both marketplaces named `jig`, listing `jig` at `./plugin` alone.
 */
export function manifestFindings(files: Record<string, Json>): Finding[] {
  const claude = files[CLAUDE_MANIFEST] ?? {};
  const codex = files[CODEX_MANIFEST] ?? {};
  const differing = SHARED_FIELDS.filter(
    (field) => JSON.stringify(claude[field]) !== JSON.stringify(codex[field]),
  ).map((field) =>
    finding(
      CODEX_MANIFEST,
      `"${field}" differs from ${CLAUDE_MANIFEST}`,
      `give both manifests the same "${field}": the two tools install one plugin`,
    ),
  );
  return [
    ...pluginManifestFindings(CLAUDE_MANIFEST, claude),
    ...pluginManifestFindings(CODEX_MANIFEST, codex),
    ...differing,
    ...marketplaceFindings(CLAUDE_MARKETPLACE, files, "./plugin"),
    ...marketplaceFindings(CODEX_MARKETPLACE, files, {
      source: "local",
      path: "./plugin",
    }),
  ];
}

/** One plugin manifest: named `jig`, at a `major.minor.patch` version. */
function pluginManifestFindings(file: string, manifest: Json): Finding[] {
  const out: Finding[] = [];
  if (manifest.name !== NAME)
    out.push(
      finding(
        file,
        `the plugin is named ${JSON.stringify(manifest.name)}, not "${NAME}"`,
        `keep "${NAME}": a new name is a new plugin to every machine; a rename goes through the marketplace's \`renames\` map (plugin/AGENTS.md)`,
      ),
    );
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest.version)))
    out.push(
      finding(
        file,
        `version ${JSON.stringify(manifest.version)} is not major.minor.patch`,
        "the release step writes the version; restore the one on main",
      ),
    );
  return out;
}

/** One marketplace file: named `jig`, listing `jig` at `source` alone. */
function marketplaceFindings(
  file: string,
  files: Record<string, Json>,
  source: unknown,
): Finding[] {
  const marketplace = files[file] ?? {};
  const plugins = Array.isArray(marketplace.plugins)
    ? (marketplace.plugins as Json[])
    : [];
  const out: Finding[] = [];
  if (marketplace.name !== NAME)
    out.push(
      finding(
        file,
        `the marketplace is named ${JSON.stringify(marketplace.name)}, not "${NAME}"`,
        `keep "${NAME}": machines registered it under that name, and the plugin id is ${NAME}@${NAME}`,
      ),
    );
  const only = plugins.length === 1 ? plugins[0] : undefined;
  if (
    only?.name !== NAME ||
    JSON.stringify(only?.source) !== JSON.stringify(source)
  )
    out.push(
      finding(
        file,
        `the marketplace must list one plugin, "${NAME}", with source ${JSON.stringify(source)}`,
        "list plugin/ as the one plugin (docs/adr/ADR-0002-the-plugin-is-its-directory.md)",
      ),
    );
  return out;
}

/** Whether `claude` runs here; only a missing executable means it does not. */
function claudeAvailable(): boolean {
  const result = spawnSync("claude", ["--version"], {
    env: gitEnv(),
    timeout: 60_000,
  });
  return (result.error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT";
}

/** Run `claude plugin validate --strict` on `target`; a finding when it fails. */
function validate(target: string, shown: string): Finding | null {
  const result = spawnSync(
    "claude",
    ["plugin", "validate", "--strict", target],
    {
      env: gitEnv(),
      timeout: 120_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return null;
  return finding(
    shown,
    `claude plugin validate --strict fails as installed:\n${(result.stdout + result.stderr).trim()}`,
    "fix what the validator names; a file only development needs belongs in __tests__/ or is left out by tools/plugin/artifact.ts",
  );
}

/** The four JSON files from the built artifact, or why they cannot be read. */
function readFiles(out: string): Record<string, Json> | string {
  const files: Record<string, Json> = {};
  for (const file of [
    CLAUDE_MANIFEST,
    CODEX_MANIFEST,
    CLAUDE_MARKETPLACE,
    CODEX_MARKETPLACE,
  ])
    try {
      files[file] = JSON.parse(readFileSync(join(out, file), "utf8"));
    } catch (error) {
      return `${file} is not in the artifact or is not JSON: ${error instanceof Error ? error.message : String(error)}`;
    }
  return files;
}

/**
 * Claude Code's validator over the artifact: its marketplace (which validates
 * the plugin it lists) and its plugin. Null when `claude` is not here.
 */
function validatorFindings(out: string): Finding[] | null {
  if (!claudeAvailable()) return null;
  return [
    validate(out, CLAUDE_MARKETPLACE),
    validate(join(out, PLUGIN_DIR), PLUGIN_DIR),
  ].filter((found): found is Finding => found !== null);
}

export function checkPlugin(
  root = ".",
  env: Record<string, string | undefined> = process.env,
): number {
  const out = mkdtempSync(join(tmpdir(), "jig-plugin-artifact-"));
  try {
    try {
      writeWorkingArtifact(root, out);
    } catch (error) {
      return couldNotCheck(
        RULE,
        `building the artifact failed: ${error instanceof Error ? error.message : String(error)}`,
        env,
      );
    }
    const files = readFiles(out);
    if (typeof files === "string") return couldNotCheck(RULE, files, env);
    const validated = validatorFindings(out);
    if (validated === null && env.JIG_REQUIRE_CLAUDE === "1")
      return couldNotCheck(
        RULE,
        "`claude` is not on PATH and JIG_REQUIRE_CLAUDE=1 demands Claude Code's validator",
        env,
      );
    if (validated === null)
      console.warn(
        `${RULE}: claude is not on PATH, so the plugin was not run through Claude Code's validator; set JIG_REQUIRE_CLAUDE=1 to make that an error`,
      );
    const findings = [...manifestFindings(files), ...(validated ?? [])];
    if (findings.length) {
      reportFindings(findings, env);
      return 1;
    }
    console.log(
      `${RULE}: OK — manifests and marketplaces agree${validated ? "; claude plugin validate --strict passes on the artifact" : ""}`,
    );
    return 0;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (import.meta.main) cli(() => checkPlugin(process.argv[2]));
