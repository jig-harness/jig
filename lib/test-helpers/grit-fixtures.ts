/**
 * The self-test behind a directory of GritQL lint rules: each rule runs alone
 * against its two fixtures through Biome, and the plugin diagnostics it
 * reports are compared with what the fixture's first line expects
 * (`// expect: <n>`). `bad.ts` holds the shapes the rule must match and
 * `good.ts` the look-alikes it must leave alone, so a widened pattern fails
 * here before it floods the ratchet. Shared by Jig's own rules in
 * `tools/quality/grit/` and the module reference rules, so both self-tests
 * read the fixtures the same way.
 */
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../record.ts";

/** What a fixture run could not do, as opposed to findings it did not expect. */
class GritFixtureError extends Error {
  readonly code = "grit-fixture";
}

const root = join(import.meta.dir, "..", "..");
// Bun.which applies Windows' executable extensions to the installed shim.
const biome =
  Bun.which("biome", { PATH: join(root, "node_modules", ".bin") }) ?? "biome";

/** The two fixtures every rule carries. */
export const FIXTURES = ["bad.ts", "good.ts"] as const;

/** The rules in `dir`: each `<name>.grit`, by name, in name order. */
export function ruleNames(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".grit"))
    .map((f) => f.slice(0, -".grit".length))
    .sort();
}

/** The fixture files `rule` carries under `dir/fixtures/<rule>/`, sorted. */
export function fixtureFiles(dir: string, rule: string): string[] {
  return readdirSync(join(dir, "fixtures", rule)).sort();
}

/** The count of findings a fixture's first line expects. */
export function expectedFindings(fixturePath: string): number {
  const text = readFileSync(fixturePath, "utf8");
  const stated = /^\/\/ expect: (\d+)/.exec(text)?.[1];
  if (stated === undefined)
    throw new GritFixtureError(
      `${fixturePath}: the first line must read "// expect: <n>"`,
    );
  return Number(stated);
}

/** What one Biome run left behind. */
export interface LintOutcome {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Biome's exit status when the only errors it reports are lint findings. */
const FINDINGS_EXIT = 1;

const isRunFailure = (d: unknown): boolean =>
  !isRecord(d) ||
  d.category === "parse" ||
  (d.category !== "plugin" &&
    (d.severity === "error" || d.severity === "fatal"));

const isErrorFinding = (d: unknown): boolean =>
  isRecord(d) && d.category === "plugin" && d.severity === "error";

function parsedReport(what: string, outcome: LintOutcome): unknown {
  try {
    return JSON.parse(outcome.stdout);
  } catch {
    throw new GritFixtureError(
      `${what}: Biome printed no JSON report: ${outcome.stderr}`,
    );
  }
}

/**
 * The plugin diagnostics' messages in one Biome run, once the run is known
 * to have checked the file. A fixture that does not parse, a configuration
 * or plugin that does not load, or an exit status that lint findings do not
 * explain fails the run, so a broken fixture cannot pass as one without
 * findings.
 */
export function pluginMessages(what: string, outcome: LintOutcome): string[] {
  const report = parsedReport(what, outcome);
  const diagnostics = isRecord(report) ? report.diagnostics : undefined;
  if (!Array.isArray(diagnostics))
    throw new GritFixtureError(
      `${what}: Biome reported no diagnostics list: ${outcome.stderr}`,
    );
  const failure = diagnostics.find(isRunFailure);
  if (failure !== undefined)
    throw new GritFixtureError(
      `${what}: Biome could not check the file: ${JSON.stringify(failure)}`,
    );
  const explained =
    outcome.exitCode === 0 ||
    (outcome.exitCode === FINDINGS_EXIT && diagnostics.some(isErrorFinding));
  if (!explained)
    throw new GritFixtureError(
      `${what}: Biome exited with ${outcome.exitCode}: ${outcome.stderr}`,
    );
  return diagnostics
    .filter((d) => isRecord(d) && d.category === "plugin")
    .map((d) => String(isRecord(d) ? d.message : d));
}

/**
 * The messages of the plugin diagnostics `rule` (in `dir`) reports when it
 * lints `fixture` alone, with Biome's built-in rules off.
 */
export function ruleFindings(
  dir: string,
  rule: string,
  fixture: string,
): string[] {
  const scratch = mkdtempSync(join(tmpdir(), "grit-"));
  try {
    copyFileSync(join(dir, `${rule}.grit`), join(scratch, "rule.grit"));
    copyFileSync(join(dir, "fixtures", rule, fixture), join(scratch, "f.ts"));
    writeFileSync(
      join(scratch, "biome.json"),
      JSON.stringify({
        root: true,
        linter: { rules: { preset: "none" } },
        plugins: ["./rule.grit"],
      }),
    );
    const r = Bun.spawnSync(
      [biome, "lint", "--reporter=json", "--max-diagnostics=none", "f.ts"],
      { cwd: scratch, stdout: "pipe", stderr: "pipe" },
    );
    return pluginMessages(`${rule}: ${fixture}`, {
      exitCode: r.exitCode,
      stdout: r.stdout.toString(),
      stderr: r.stderr.toString(),
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
