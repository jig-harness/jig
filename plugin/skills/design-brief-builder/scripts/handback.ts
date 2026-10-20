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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { consumerRoot, readConfig } from "../../../shared/consumer.ts";
import { isRecord, decodeJson, isStringArray } from "../../../shared/guards.ts";
import {
  generatedPath,
  parseManifest,
  pathKey,
  screenshotPath,
  parseReport,
  reportFile,
  settingsRequirement,
  validSettings,
  type Report,
  type Manifest,
  type Settings,
} from "./contracts.ts";
import { renderBundle } from "./browser.ts";
import { decodePng, sameImage, type Image } from "./png.ts";

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
        // Parsed by machine: no user color, external diff or textconv may reshape it.
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
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
        const count = match[2] === undefined ? 1 : Number(match[2]);
        // A zero-count hunk names the boundary after line N, not a line at N.
        const start = count
          ? Math.max(0, Number(match[1]) - 1)
          : Number(match[1]);
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
/**
 * The Markdown a reader sees as prose: HTML comments removed, and fenced code
 * blocks removed by CommonMark's rules (an opening fence indented up to three
 * spaces, closed by a fence of the same character at least as long, or by the
 * end of the document).
 */
function operative(text: string): string {
  const lines = text.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split("\n");
  const kept: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker?.[1]?.[0] === fence.char &&
        marker[1].length >= fence.length &&
        !marker[2]?.trim()
      )
        fence = null;
      continue;
    }
    if (marker?.[1] && !(marker[1][0] === "`" && marker[2]?.includes("`"))) {
      fence = { char: marker[1][0] ?? "", length: marker[1].length };
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
}
/**
 * Every value a document declares as a `<label>:` line in its operative
 * prose: each line that starts with the label counts, and its whole trimmed
 * remainder is the value, so a malformed declaration is compared, never dropped.
 */
function declarations(text: string, label: string): string[] {
  return [
    ...operative(text).matchAll(new RegExp(`^${label}:(.*)$`, "gim")),
  ].map((m) => (m[1] ?? "").trim());
}
/** The one `<label>:` value a document declares, or why it does not declare exactly one. */
function declared(
  text: string,
  label: string,
  source: string,
): { value: string } | { failure: string } {
  const values = declarations(text, label);
  return values.length === 1
    ? { value: values[0] ?? "" }
    : {
        failure: `${source} requires exactly one ${label} line, found ${values.length}`,
      };
}
/** The one `Bar outcome:` a document declares, outside comments and fenced examples. */
export function outcomeFailure(text: string, source: string): string | null {
  const outcome = declared(text, "Bar outcome", source);
  if ("failure" in outcome) return outcome.failure;
  return outcome.value === "pass"
    ? null
    : `${source} requires Bar outcome: pass`;
}
export function staticChecks(input: StaticInput): string[] {
  const failures: string[] = [];
  for (const [path, text] of Object.entries(input.files))
    failures.push(...fileChecks(path, text, input.terms));
  if (!input.screenshotFresh)
    failures.push(
      "screenshots must be newer than every file the scenarios can load",
    );
  if (!input.screenshotChanged)
    failures.push("screenshots must differ from the previous round");
  const outcome = outcomeFailure(input.readme, "README");
  if (outcome) failures.push(outcome);
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
/**
 * Refuses two paths with one `pathKey`: a file system that folds case or
 * Unicode normalization stores them as one file, one that does not stores
 * them as two, so only a bundle without such aliases has one identity per
 * file everywhere.
 */
export function distinctPaths(paths: string[], source: string): string[] {
  const seen = new Map<string, string>();
  for (const path of paths) {
    const other = seen.get(pathKey(path));
    if (other !== undefined)
      throw new ExitError(
        2,
        `${source}: ${other} and ${path} differ only in case or Unicode normalization`,
      );
    seen.set(pathKey(path), path);
  }
  return paths;
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
  const names = distinctPaths(
    git("ls-tree", "-r", "--name-only", "-z", ref, "--", bundle)
      .split("\0")
      .filter(Boolean),
    `${ref}:${bundle}`,
  );
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
  const recorded = declarations(readme, "Export base");
  if (recorded.length > 1)
    throw new ExitError(2, "README records more than one Export base");
  const marker = recorded[0]?.match(/^[a-f\d]{40,64}$/) ? recorded[0] : null;
  if (recorded.length && !marker)
    throw new ExitError(
      2,
      `README Export base is not a commit: ${recorded[0]}`,
    );
  const commit =
    marker ??
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
  if ([b, o, result].some((v) => v?.includes(0)))
    return same(b, o) || same(o, result)
      ? []
      : [
          {
            file,
            hunk: "binary content differs from the repository version",
            acknowledged: false,
          },
        ];
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
    `${previous.replace(exportMetadata, "").trimEnd()}\n\nExport base: ${report.exportBase}\nExport base provenance: raw export\nPrevious export base: ${report.previousExportBase}\nPrevious export base provenance: ${report.provenance}\n`,
  );
  writeFileSync(
    join(output, "handback-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
}
/** The bundle as Git names it: repository-relative, `/`-separated, no `./`. */
function bundlePath(bundle: string): string {
  const path = relative(consumerRoot(), resolve(consumerRoot(), bundle));
  if (
    !bundle ||
    bundle.startsWith("-") ||
    isAbsolute(bundle) ||
    !path ||
    path === ".." ||
    path.startsWith(`..${sep}`) ||
    isAbsolute(path)
  )
    throw new ExitError(2, "Bundle must be a repository-relative directory");
  return path.split(sep).join("/");
}
/** README export-base lines are rewritten each round, so they are never a repository fix. */
function comparable(
  path: string,
  file: Buffer | undefined,
): Buffer | undefined {
  if (path !== "README.md" || !file) return file;
  return Buffer.from(file.toString().replace(exportMetadata, ""));
}
const exportMetadata = /^(?:Previous )?Export base(?: provenance)?:.*\n?/gim;
export function mergeBundle(
  requested: string,
  raw: string,
  output: string,
  ours: string,
): Report {
  const bundle = bundlePath(requested);
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
    if (generatedPath(path)) continue;
    const b = baseFiles.get(path),
      o = oursFiles.get(path),
      t = returned.get(path);
    const { result, conflict } = mergeFile(b, o, t);
    if (conflict) report.conflicts.push(path);
    report.regressions.push(
      ...lostHunks(
        path,
        comparable(path, b),
        comparable(path, o),
        comparable(path, result),
      ),
    );
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
  if (!validSettings(value)) throw new ExitError(2, settingsRequirement);
  return value;
}
/** Every delivered screenshot path, with the width it is evidence for. */
function screenshots(manifest: Manifest, widths: number[]): string[] {
  return manifest.scenarios.flatMap((s) =>
    widths.map((width) =>
      width === widths[0]
        ? (screenshotPath(s.screenshot) ?? "")
        : (screenshotPath(s.screenshot) ?? "").replace(
            /(\.[^.]+)$/,
            `-${width}$1`,
          ),
    ),
  );
}
function image(data: Buffer): Image | string {
  try {
    return decodePng(data);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
/**
 * Screenshots must postdate every file the renderer can load, and differ as
 * images from the previous round's.
 */
function screenshotChecks(
  dir: string,
  files: string[],
  evidence: string[],
  previous: Map<string, Buffer>,
): { fresh: boolean; changed: boolean; failures: string[] } {
  const evidenceKeys = new Set(evidence.map(pathKey));
  const delivered = new Map(files.map((p) => [pathKey(p), p]));
  const before = new Map(
    [...previous].map(([p, data]) => [pathKey(p), data] as const),
  );
  const inputs = files.filter(
    (p) =>
      !p.endsWith("/") &&
      !evidenceKeys.has(pathKey(p)) &&
      !generatedPath(p) &&
      p !== "README.md",
  );
  const newestInput = Math.max(
    0,
    ...inputs.map((p) => statSync(safe(dir, p)).mtimeMs),
  );
  let fresh = true,
    changed = true;
  const failures: string[] = [];
  for (const path of evidence) {
    const actual = delivered.get(pathKey(path));
    if (actual === undefined || actual.endsWith("/")) {
      fresh = false;
      changed = false;
      continue;
    }
    const file = safe(dir, actual);
    fresh &&= statSync(file).mtimeMs > newestInput;
    const shot = image(readFileSync(file));
    if (typeof shot === "string") {
      failures.push(`screenshot is not a valid PNG (${shot}): ${path}`);
      changed = false;
      continue;
    }
    const old = before.get(pathKey(path));
    const last = old && image(old);
    if (last) changed &&= typeof last === "string" || !sameImage(last, shot);
  }
  return { fresh, changed, failures };
}
/** The final bundle's files, as the merge would compare them. */
function currentFiles(dir: string, files: string[]): Map<string, Buffer> {
  return new Map(
    files
      .filter((p) => !p.endsWith("/") && !generatedPath(p))
      .map((p) => [p, readFileSync(safe(dir, p))] as const),
  );
}
/**
 * Lost repository hunks in the files as they stand now, so an edit after the
 * merge cannot drop a fix the report never listed.
 */
function currentRegressions(
  bundle: string,
  report: Report,
  current: Map<string, Buffer>,
): Report["regressions"] {
  const base = tree(report.previousExportBase, bundle);
  const ours = tree(report.ours, bundle);
  return [...new Set([...base.keys(), ...ours.keys(), ...current.keys()])]
    .filter((path) => !generatedPath(path))
    .flatMap((path) =>
      lostHunks(
        path,
        comparable(path, base.get(path)),
        comparable(path, ours.get(path)),
        comparable(path, current.get(path)),
      ),
    );
}
function evidenceChecks(
  root: string,
  config: Settings,
  report: Report,
  regressions: Report["regressions"],
): string[] {
  const failures: string[] = [];
  for (const path of [config.rubric, config.scorecard])
    if (
      !existsSync(safe(root, path)) ||
      !readFileSync(safe(root, path), "utf8").trim()
    )
      failures.push(`missing or empty review evidence: ${path}`);
  if (existsSync(safe(root, config.scorecard))) {
    const scorecard = readFileSync(safe(root, config.scorecard), "utf8");
    const outcome = outcomeFailure(scorecard, "scorecard");
    if (outcome) failures.push(outcome);
    const reviewed = declared(scorecard, "Reviewed export base", "scorecard");
    if ("value" in reviewed ? reviewed.value !== report.exportBase : true)
      failures.push(
        `scorecard must record the round it reviewed: Reviewed export base: ${report.exportBase}`,
      );
  }
  for (const path of report.conflicts)
    failures.push(
      `resolve recorded conflict and remove its report entry: ${path}`,
    );
  const acknowledged = new Set(
    report.regressions
      .filter((r) => r.acknowledged === true)
      .map((r) => `${r.file}\0${r.hunk}`),
  );
  for (const regression of regressions)
    if (!acknowledged.has(`${regression.file}\0${regression.hunk}`))
      failures.push(
        `review lost repository hunk: ${regression.file}: ${regression.hunk}`,
      );
  return failures;
}
function textEvidence(
  config: Settings,
  readme: string,
  current: Map<string, Buffer>,
  files: string[],
): { files: Record<string, string>; terms: string[] } {
  const textFiles = Object.fromEntries(
    [...current]
      .filter(([p]) => !/\.(png|jpg|jpeg|webp|woff2?|ttf|ico|pdf)$/i.test(p))
      .map(([p, data]) => [p, data.toString("utf8")]),
  );
  const terms = [
    ...(config.forbidden_terms ?? []),
    ...declarations(readme, "Forbidden terms").flatMap((line) =>
      line
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  return {
    files: {
      ...Object.fromEntries(files.map((path) => [path, ""])),
      ...textFiles,
    },
    terms,
  };
}
/** Everything the landing check verifies without a browser, and what the browser then renders. */
export function landingFailures(requested: string): {
  failures: string[];
  render: () => Promise<string[]>;
} {
  const root = consumerRoot();
  const bundle = bundlePath(requested);
  const dir = safe(root, bundle);
  const config = settings();
  const manifest = parseManifest(
    readFileSync(join(dir, "design-handback.json"), "utf8"),
  );
  const report = parseReport(readFileSync(join(dir, reportFile), "utf8"));
  git("merge-base", "--is-ancestor", report.exportBase, "HEAD");
  const readme = readFileSync(join(dir, "README.md"), "utf8");
  const recorded = declared(readme, "Export base", "README");
  if (!("value" in recorded) || recorded.value !== report.exportBase)
    throw new ExitError(
      2,
      "README export base differs from raw delivery report",
    );
  const files = distinctPaths(list(dir), bundle);
  const current = currentFiles(dir, files);
  const evidence = screenshots(manifest, config.widths);
  const keys = evidence.map(pathKey);
  const collision = evidence.find(
    (path, i) => keys.indexOf(pathKey(path)) !== i,
  );
  if (collision !== undefined)
    throw new ExitError(
      2,
      `design-handback.json: two scenario/width screenshots both resolve to ${collision}`,
    );
  const shots = screenshotChecks(
    dir,
    files,
    evidence,
    tree(report.ours, bundle),
  );
  const { files: text, terms } = textEvidence(config, readme, current, files);
  const failures = staticChecks({
    files: text,
    terms,
    readme,
    screenshotFresh: shots.fresh,
    screenshotChanged: shots.changed,
  });
  failures.push(...shots.failures);
  failures.push(
    ...evidenceChecks(
      root,
      config,
      report,
      currentRegressions(bundle, report, current),
    ),
  );
  return {
    failures,
    render: async () =>
      (
        await renderBundle(
          dir,
          manifest.scenarios,
          config.widths,
          config.browser_executable,
          terms,
        )
      ).failures,
  };
}
export async function checkBundle(requested: string): Promise<string[]> {
  const landing = landingFailures(requested);
  return [...landing.failures, ...(await landing.render())];
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
