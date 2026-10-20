import { ExitError } from "../../../shared/cli.ts";
/** Three-way design delivery and mechanical landing, from the consumer root. */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { consumerRoot, readConfig } from "../../../shared/consumer.ts";
import { isRecord, decodeJson, isStringArray } from "../../../shared/guards.ts";
import {
  parseManifest,
  parseReport,
  validSettings,
  type Report,
  type Manifest,
  type Settings,
} from "./contracts.ts";
import { renderBundle } from "./browser.ts";

function run(argv: string[], cwd = consumerRoot()): string {
  const p = Bun.spawnSync(argv, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 60000,
  });
  if (p.exitCode !== 0)
    throw new ExitError(2, `${argv[0]} failed: ${p.stderr.toString()}`);
  return p.stdout.toString();
}
function git(...args: string[]): string {
  return run(["git", ...args]);
}
function temporary<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "jig-design-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
export function mergeText(
  base: string,
  ours: string,
  theirs: string,
): { text: string; conflict: boolean } {
  return temporary((dir) => {
    for (const [name, value] of Object.entries({ base, ours, theirs }))
      writeFileSync(join(dir, name), value);
    const p = Bun.spawnSync(
      [
        "git",
        "merge-file",
        "-p",
        "--diff3",
        join(dir, "ours"),
        join(dir, "base"),
        join(dir, "theirs"),
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 60000 },
    );
    if (p.exitCode < 0 || p.exitCode > 127)
      throw new ExitError(2, p.stderr.toString());
    return { text: p.stdout.toString(), conflict: p.exitCode !== 0 };
  });
}
/** Conservatively flag each changed hunk whose replacement is absent or deleted text returns. */
export function regressedHunks(
  base: string,
  ours: string,
  merged: string,
): string[] {
  return temporary((dir) => {
    writeFileSync(join(dir, "base"), base);
    writeFileSync(join(dir, "ours"), ours);
    const p = Bun.spawnSync(
      [
        "git",
        "diff",
        "--no-index",
        "--unified=0",
        join(dir, "base"),
        join(dir, "ours"),
      ],
      { stdout: "pipe", stderr: "pipe", timeout: 60000 },
    );
    if (p.exitCode !== 0 && p.exitCode !== 1)
      throw new ExitError(2, p.stderr.toString());
    return p.stdout
      .toString()
      .split(/(?=^@@ )/m)
      .slice(1)
      .filter((hunk) => {
        if (merged === ours) return false;
        if (merged === base) return true;
        const match = hunk.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (!match) return true;
        const start = Math.max(0, Number(match[1]) - 1);
        const count = match[2] === undefined ? 1 : Number(match[2]);
        const oursLines = ours.split("\n");
        const mergedLines = merged.split("\n");
        const from = Math.max(0, start - 1),
          to = Math.min(oursLines.length, start + count + 1);
        return (
          oursLines.slice(from, to).join("\n") !==
          mergedLines.slice(from, to).join("\n")
        );
      });
  });
}
interface StaticInput {
  files: Record<string, string>;
  terms: string[];
  readme: string;
  screenshotFresh: boolean;
  screenshotChanged: boolean;
}
function fileChecks(path: string, text: string, terms: string[]): string[] {
  const failures: string[] = [];
  if (path.includes("uploads/uploads/"))
    failures.push(`nested uploads: ${path}`);
  if (/(?:-|_)[a-f\d]{8,}(?:\.[^.]+)$/i.test(path) && path.includes("uploads/"))
    failures.push(`hash-suffixed duplicate upload: ${path}`);
  if (/^(?:<{7}|={7}|>{7}|\|{7})(?: |$)/m.test(text))
    failures.push(`unresolved conflict: ${path}`);
  for (const term of terms)
    if (
      (path === "README.md"
        ? text.replace(/^Forbidden terms:.*$/gim, "")
        : text
      )
        .toLowerCase()
        .includes(term.toLowerCase())
    )
      failures.push(`forbidden text '${term}': ${path}`);
  return failures;
}
export function staticChecks(input: StaticInput): string[] {
  const failures: string[] = [];
  for (const [path, text] of Object.entries(input.files))
    failures.push(...fileChecks(path, text, input.terms));
  if (!input.screenshotFresh)
    failures.push("screenshots must be newer than the prototype");
  if (!input.screenshotChanged)
    failures.push("screenshots must differ from the previous round");
  if (!/^Bar outcome: pass\s*$/im.test(input.readme))
    failures.push("README requires Bar outcome: pass");
  return failures;
}
function safe(root: string, path: string): string {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (
    isAbsolute(path) ||
    rel === ".." ||
    rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(rel)
  )
    throw new ExitError(2, `path escapes bundle: ${path}`);
  return target;
}
function list(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new ExitError(2, `symbolic links are not bundle files: ${path}`);
      return entry.isDirectory() ? [`${path}/`, ...list(dir, path)] : [path];
    },
  );
}
function tree(ref: string, bundle: string): Map<string, Buffer> {
  git("rev-parse", "--verify", `${ref}^{commit}`);
  if (
    git("ls-tree", "-r", ref, "--", bundle)
      .split("\n")
      .some((line) => line.startsWith("120000 ") || line.startsWith("160000 "))
  )
    throw new ExitError(2, "Bundle cannot contain symlinks or submodules");
  const names = git("ls-tree", "-r", "--name-only", "-z", ref, "--", bundle)
    .split("\0")
    .filter(Boolean);
  return new Map(
    names.map((path) => {
      const p = Bun.spawnSync(["git", "show", `${ref}:${path}`], {
        cwd: consumerRoot(),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 60000,
      });
      if (p.exitCode !== 0) throw new ExitError(2, p.stderr.toString());
      return [path.slice(bundle.length + 1), Buffer.from(p.stdout)] as const;
    }),
  );
}
function baseOf(
  readme: string,
  bundle: string,
  ours: string,
): { commit: string; provenance: string } {
  const marker = readme.match(/^Export base: ([a-f\d]{40,64})\s*$/im);
  const commit =
    marker?.[1] ??
    git(
      "log",
      "--reverse",
      "--diff-filter=A",
      "--format=%H",
      ours,
      "--",
      `${bundle}/`,
    )
      .trim()
      .split("\n")[0];
  if (!commit)
    throw new ExitError(2, "No recorded export or first-added commit found");
  git("rev-parse", "--verify", `${commit}^{commit}`);
  return {
    commit,
    provenance: marker
      ? "raw export"
      : "first-added fallback (no recorded raw export)",
  };
}
function same(a: Buffer | undefined, b: Buffer | undefined): boolean {
  return a === undefined ? b === undefined : b !== undefined && a.equals(b);
}
function mergeFile(
  b: Buffer | undefined,
  o: Buffer | undefined,
  t: Buffer | undefined,
): { result: Buffer | undefined; conflict: boolean } {
  if (same(o, t) || same(b, t)) return { result: o, conflict: false };
  if (same(b, o)) return { result: t, conflict: false };
  if (o && t && ![b, o, t].some((v) => v?.includes(0))) {
    const merged = mergeText(b?.toString() ?? "", o.toString(), t.toString());
    return { result: Buffer.from(merged.text), conflict: merged.conflict };
  }
  return { result: o ?? t, conflict: true };
}
function lostHunks(
  file: string,
  b: Buffer | undefined,
  o: Buffer | undefined,
  result: Buffer | undefined,
): Report["regressions"] {
  if ([b, o, result].some((v) => v?.includes(0))) return [];
  return regressedHunks(
    b?.toString() ?? "",
    o?.toString() ?? "",
    result?.toString() ?? "",
  ).map((hunk) => ({ file, hunk, acknowledged: false }));
}
function writeMetadata(output: string, report: Report): void {
  const previous = existsSync(join(output, "README.md"))
    ? readFileSync(join(output, "README.md"), "utf8")
    : "";
  writeFileSync(
    join(output, "README.md"),
    `${previous.replace(/^(?:Previous )?Export base(?: provenance)?:.*\n?/gim, "").trimEnd()}\n\nExport base: ${report.exportBase}\nExport base provenance: raw export\nPrevious export base: ${report.previousExportBase}\nPrevious export base provenance: ${report.provenance}\n`,
  );
  writeFileSync(
    join(output, "handback-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
function validateBundlePath(bundle: string): void {
  if (
    !bundle ||
    bundle.startsWith("-") ||
    isAbsolute(bundle) ||
    relative(consumerRoot(), resolve(consumerRoot(), bundle)).startsWith("..")
  )
    throw new ExitError(2, "Bundle must be a repository-relative directory");
}
export function mergeBundle(
  bundle: string,
  raw: string,
  output: string,
  ours: string,
): Report {
  validateBundlePath(bundle);
  const oursFiles = tree(ours, bundle);
  const readme = oursFiles.get("README.md")?.toString() ?? "";
  const base = baseOf(readme, bundle, ours);
  const baseFiles = tree(base.commit, bundle);
  const returned = tree(raw, bundle);
  if (!returned.size || !oursFiles.size)
    throw new ExitError(2, "Both raw export and ours must contain the bundle");
  if (existsSync(output))
    throw new ExitError(2, "Output directory must not exist");
  const report: Report = {
    version: 1,
    ours: git("rev-parse", `${ours}^{commit}`).trim(),
    exportBase: git("rev-parse", `${raw}^{commit}`).trim(),
    previousExportBase: base.commit,
    provenance: base.provenance,
    conflicts: [],
    regressions: [],
  };
  mkdirSync(output, { recursive: true });
  for (const path of new Set([
    ...baseFiles.keys(),
    ...oursFiles.keys(),
    ...returned.keys(),
  ])) {
    if (path === "handback-report.json") continue;
    const b = baseFiles.get(path),
      o = oursFiles.get(path),
      t = returned.get(path);
    const { result, conflict } = mergeFile(b, o, t);
    if (conflict) report.conflicts.push(path);
    report.regressions.push(...lostHunks(path, b, o, result));
    if (result) {
      mkdirSync(dirname(safe(output, path)), { recursive: true });
      writeFileSync(safe(output, path), result);
    }
  }
  writeMetadata(output, report);
  return report;
}
function settings(): Settings {
  const value = (
    readConfig().design_brief as { handback?: Settings } | undefined
  )?.handback;
  if (!validSettings(value))
    throw new ExitError(
      2,
      "Configure design_brief.handback widths, rubric, scorecard and browser_executable",
    );
  return value;
}
function screenshotStatus(
  dir: string,
  manifest: Manifest,
  config: Settings,
  previous: Map<string, Buffer>,
): { fresh: boolean; changed: boolean } {
  const prototype = statSync(safe(dir, manifest.prototype));
  let fresh = true,
    changed = true;
  for (const s of manifest.scenarios)
    for (const width of config.widths) {
      const path =
        width === config.widths[0]
          ? s.screenshot
          : s.screenshot.replace(/(\.[^.]+)$/, `-${width}$1`);
      const image = safe(dir, path);
      if (!existsSync(image)) {
        fresh = false;
        changed = false;
        continue;
      }
      fresh &&= statSync(image).mtimeMs > prototype.mtimeMs;
      const old = previous.get(path);
      if (old) changed &&= !old.equals(readFileSync(image));
    }
  return { fresh, changed };
}
function evidenceChecks(
  root: string,
  config: Settings,
  report: Report,
): string[] {
  const failures: string[] = [];
  for (const path of [config.rubric, config.scorecard])
    if (
      !existsSync(safe(root, path)) ||
      !readFileSync(safe(root, path), "utf8").trim()
    )
      failures.push(`missing or empty review evidence: ${path}`);
  if (
    existsSync(safe(root, config.scorecard)) &&
    !/^Bar outcome: pass\s*$/im.test(
      readFileSync(safe(root, config.scorecard), "utf8"),
    )
  )
    failures.push("scorecard requires Bar outcome: pass");
  for (const path of report.conflicts)
    failures.push(
      `resolve recorded conflict and remove its report entry: ${path}`,
    );
  for (const regression of report.regressions)
    if (regression.acknowledged !== true)
      failures.push(
        `review lost repository hunk: ${regression.file}: ${regression.hunk}`,
      );
  return failures;
}
function textEvidence(
  dir: string,
  config: Settings,
  readme: string,
): { files: Record<string, string>; terms: string[] } {
  const allPaths = list(dir);
  const textFiles = Object.fromEntries(
    allPaths
      .filter(
        (p) =>
          !p.endsWith("/") &&
          !p.startsWith(".handback-render/") &&
          !p.endsWith("handback-report.json") &&
          !/\.(png|jpg|jpeg|webp|woff2?|ttf|ico|pdf)$/i.test(p),
      )
      .map((p) => [p, readFileSync(safe(dir, p), "utf8")]),
  );
  const terms = [
    ...(config.forbidden_terms ?? []),
    ...(readme
      .match(/^Forbidden terms: (.+)$/im)?.[1]
      ?.split(",")
      .map((s) => s.trim())
      .filter(Boolean) ?? []),
  ];
  return {
    files: {
      ...Object.fromEntries(allPaths.map((path) => [path, ""])),
      ...textFiles,
    },
    terms,
  };
}
export async function checkBundle(bundle: string): Promise<string[]> {
  const root = consumerRoot();
  const dir = safe(root, bundle);
  const config = settings();
  const manifest = parseManifest(
    readFileSync(join(dir, "design-handback.json"), "utf8"),
  );
  const report = parseReport(
    readFileSync(join(dir, "handback-report.json"), "utf8"),
  );
  git("merge-base", "--is-ancestor", report.exportBase, "HEAD");
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  if (!readme.includes(`Export base: ${report.exportBase}`))
    throw new ExitError(
      2,
      "README export base differs from raw delivery report",
    );
  const previous = tree(report.ours, bundle);
  const { fresh, changed } = screenshotStatus(dir, manifest, config, previous);
  const { files, terms } = textEvidence(dir, config, readme);
  const failures = staticChecks({
    files,
    terms,
    readme,
    screenshotFresh: fresh,
    screenshotChanged: changed,
  });
  failures.push(...evidenceChecks(root, config, report));
  failures.push(
    ...(
      await renderBundle(
        dir,
        manifest.scenarios,
        config.widths,
        config.browser_executable,
        terms,
      )
    ).failures,
  );
  return failures;
}
export function facts(argv: string[], output: string): void {
  if (!argv.length) throw new ExitError(2, "Facts source command is empty");
  const raw = run(argv);
  const value = decodeJson(raw, isRecord, "facts command output");
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.keys(value).length
  )
    throw new ExitError(2, "Facts command must return a nonempty JSON object");
  mkdirSync(dirname(resolve(output)), { recursive: true });
  const escapeCell = (v: unknown) =>
    JSON.stringify(v).replaceAll("|", "\\|").replaceAll("\n", " ");
  const table = Object.entries(value)
    .map(([key, v]) => `| ${escapeCell(key)} | ${escapeCell(v)} |`)
    .join("\n");
  writeFileSync(
    output,
    `# Derived data facts\n\nCommand (argument array): \`${JSON.stringify(argv)}\`\nGenerated: ${new Date().toISOString()}\nSource output SHA-256: ${createHash("sha256").update(raw).digest("hex")}\n\n| Fact | Value |\n|------|-------|\n${table}\n`,
  );
}
if (import.meta.main) {
  try {
    const [command, bundle, raw, output, ...args] = process.argv.slice(2);
    if (command === "merge" && bundle && raw && output) {
      const pos = args.indexOf("--ours");
      const ours = args[pos + 1];
      if (pos < 0 || !ours)
        throw new ExitError(2, "merge requires --ours <previous-landed-ref>");
      const report = mergeBundle(bundle, raw, resolve(output), ours);
      console.log(JSON.stringify(report, null, 2));
      process.exitCode =
        report.conflicts.length || report.regressions.length ? 1 : 0;
    } else if (command === "check" && bundle) {
      const failures = await checkBundle(bundle);
      console.log(JSON.stringify({ failures }, null, 2));
      process.exitCode = failures.length ? 1 : 0;
    } else if (command === "facts" && bundle && raw) {
      facts(decodeJson(bundle, isStringArray, "facts argument array"), raw);
    } else
      throw new ExitError(
        2,
        "Usage: handback.ts merge <bundle> <raw-ref> <output> --ours <landed-ref> | check <bundle> | facts '<argv-json>' <output.md>",
      );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
