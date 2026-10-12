// Canonical ordered gate set: self-tests first, then repository checks.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { checkLinks } from "./check-md-links.ts";
import { checkTables } from "./check-md-tables.ts";
import { checkGlossary } from "./check-glossary-coverage.ts";
import { checkTracker } from "./check-no-tracker-refs.ts";
import { checkChangelog } from "./check-changelog.ts";
const root = join(import.meta.dir, "..");

/**
 * Suites that need a POSIX system: they stand in for commands with Bash
 * scripts and read process state through `ps`, `/proc` and POSIX signals, so
 * they cannot run on Windows. Windows runs every other suite.
 */
export const POSIX_ONLY_SUITES = [
  "plugin/skills/drive-pr/**",
  "plugin/skills/do-item/**",
];

/**
 * Suites long enough to deserve their own CI job: the drive-pr suite takes
 * about twenty minutes in one process. CI runs it split across parallel jobs
 * (`.github/workflows/gates.yml`) and sets this variable in the gate job so
 * the suite does not run twice. Locally `bun run gates` runs everything.
 */
export const SEPARATE_SUITES = ["plugin/skills/drive-pr/**"];
export const SKIP_SEPARATE_ENV = "JIG_GATES_SKIP_SEPARATE_SUITES";

/** The suite patterns this platform and environment leave out of the test step. */
export function skippedSuites(
  platform: string,
  env: Record<string, string | undefined>,
): string[] {
  const skipped = new Set<string>();
  if (platform === "win32") for (const p of POSIX_ONLY_SUITES) skipped.add(p);
  if (env[SKIP_SEPARATE_ENV] === "1")
    for (const p of SEPARATE_SUITES) skipped.add(p);
  return [...skipped];
}

/**
 * The `bun run test` arguments. Bun's `--path-ignore-patterns` replaces the
 * `bunfig.toml` list rather than adding to it, so the configured patterns are
 * passed along with the skipped suites.
 */
export function testArgs(skipped: string[], configured: string[]): string[] {
  if (!skipped.length) return ["run", "test"];
  return [
    "run",
    "test",
    ...[...configured, ...skipped].map((p) => `--path-ignore-patterns=${p}`),
  ];
}

function configuredIgnores(): string[] {
  const bunfig = Bun.TOML.parse(
    readFileSync(join(root, "bunfig.toml"), "utf8"),
  ) as { test?: { pathIgnorePatterns?: string[] } };
  return bunfig.test?.pathIgnorePatterns ?? [];
}

async function gates(): Promise<number> {
  const skipped = skippedSuites(process.platform, process.env);
  if (skipped.length)
    console.log(`test step skips (see scripts/gates.ts): ${skipped.join(" ")}`);
  const test = testArgs(skipped, configuredIgnores());
  for (const args of [
    ["run", "format:check"],
    ["run", "lint"],
    ["run", "typecheck"],
    ["run", "deadcode"],
    ["run", "audit"],
    ["run", "quality"],
    test,
    ["run", "build"],
  ]) {
    const child = Bun.spawn([process.execPath, ...args], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    const status = await child.exited;
    if (status) return status;
  }
  for (const check of [
    checkLinks,
    checkTables,
    checkGlossary,
    checkTracker,
    checkChangelog,
  ]) {
    const status = check(root);
    if (status) return status;
  }
  console.log("all gates passed");
  return 0;
}
if (import.meta.main) cli(gates);
