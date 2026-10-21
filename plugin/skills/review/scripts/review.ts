#!/usr/bin/env bun
/** Review setup and policy execution without depending on the caller's shell. */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  decodeJson,
  field,
  isRecord,
  isString,
} from "../../../shared/guards.ts";
import { layeredConfig } from "../../../shared/consumer.ts";
import { run, type RunOptions, type RunResult } from "../../../shared/proc.ts";
import { withoutTracePropagation } from "../../../shared/trace.ts";

class ReviewError extends Error {
  override name = "ReviewError";
}

interface Session {
  root: string;
  base: string;
  baseTree: string;
  files: string;
  bunfig: string;
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part === "" ||
    (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part))
  );
}
/** Code-unit order: the same on every host, whatever its locale. */
function byCodeUnit(a: string, b: string): number {
  return Number(a > b) - Number(a < b);
}
function hostEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
  ]) {
    const key = Object.keys(process.env)
      .sort(byCodeUnit)
      .find((key) => key.toUpperCase() === name);
    const value = key === undefined ? undefined : process.env[key];
    if (value !== undefined) env[name] = value;
  }
  env.NoDefaultCurrentDirectoryInExePath = "1";
  return env;
}
function checkedHostEnvironment(reviewedRoot: string): Record<string, string> {
  const env = hostEnvironment();
  const root = realpathSync(reviewedRoot);
  const directories = (env.PATH ?? "")
    .split(delimiter)
    .map((entry) => entry.replace(/^"|"$/g, ""))
    .filter(
      (directory) =>
        isAbsolute(directory) &&
        !inside(
          root,
          existsSync(directory) ? realpathSync(directory) : resolve(directory),
        ),
    );
  if (!directories.length)
    throw new ReviewError(
      "policy PATH has no trusted absolute directories outside the reviewed tree",
    );
  env.PATH = directories.join(delimiter);
  return env;
}
function policyEnvironment(state: Session): Record<string, string> {
  return {
    ...checkedHostEnvironment(state.root),
    JIG_CONSUMER_ROOT: state.baseTree,
    JIG_OVERLAY: join(state.baseTree, ".config/jig.yaml"),
    JIG_USER_LAYER: "off",
  };
}
function assertCompleted(child: RunResult, label: string): void {
  if (child.code !== 0)
    throw new ReviewError(`${label} failed: ${childFailureOutput(child)}`);
  if (child.groupSurvived)
    throw new ReviewError(
      `${label} left unfinished descendants; cancelled them instead of accepting the result`,
    );
}
function childFailureOutput(child: RunResult): string {
  return child.stderr || child.stdout || String(child.code);
}
async function call(argv: string[], options: RunOptions): Promise<string> {
  const child = await withoutTracePropagation(() =>
    run(argv, { ...options, timeoutSec: 60 }),
  );
  assertCompleted(child, `${argv[0] ?? ""} ${argv[1] ?? ""}`);
  if (child.stderr) process.stderr.write(child.stderr);
  return child.stdout;
}
/**
 * What git and gh need to reach a remote: the SSH agent, proxies, certificate
 * bundles, gh's own configuration and tokens. Policy commands never get these.
 */
const TOOL_TRANSPORT_VARIABLES = new Set([
  "SSH_AUTH_SOCK",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CURL_CA_BUNDLE",
  "GH_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "APPDATA",
  "LOCALAPPDATA",
]);
function toolEnvironment(root: string): Record<string, string> {
  const env = checkedHostEnvironment(root);
  for (const [name, value] of Object.entries(process.env))
    if (value !== undefined && TOOL_TRANSPORT_VARIABLES.has(name.toUpperCase()))
      env[name] = value;
  return env;
}
async function git(root: string, ...args: string[]): Promise<string> {
  return call(["git", ...args], {
    cwd: root,
    env: toolEnvironment(root),
  });
}
/** Locate the checkout without executing a program from an unchecked PATH. */
function reviewedRoot(): string {
  let directory = realpathSync(process.cwd());
  for (;;) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = dirname(directory);
    if (parent === directory)
      throw new ReviewError("review setup requires a Git working tree");
    directory = parent;
  }
}
function required(value: string | undefined, label: string): string {
  if (!value) throw new ReviewError(`${label} is required`);
  return value;
}
function paths(text: string): string[] {
  if (text && !text.endsWith("\0"))
    throw new ReviewError("effective file list is not NUL terminated");
  return text.split("\0").filter(Boolean);
}
function isReviewedRelativePath(root: string, path: string): boolean {
  return path !== "" && !isAbsolute(path) && inside(root, resolve(root, path));
}
function validatePath(root: string, path: string): void {
  if (/[\r\n\0]/.test(path))
    throw new ReviewError("a review path contains a newline or NUL");
  if (!isReviewedRelativePath(root, path))
    throw new ReviewError(
      `review path must stay relative to the repository: ${path}`,
    );
}
function readState(file: string): Session {
  const value = decodeJson(readFileSync(file, "utf8"), isRecord, file);
  return {
    root: field(value, "root", isString),
    base: field(value, "base", isString),
    baseTree: field(value, "baseTree", isString),
    files: field(value, "files", isString),
    bunfig: field(value, "bunfig", isString),
  };
}
function fileList(state: Session): string[] {
  const list = paths(readFileSync(state.files, "utf8"));
  for (const path of list) validatePath(state.root, path);
  return list;
}
function snapshotPath(state: Session, path: string): string {
  const absolute = resolve(state.baseTree, path);
  if (
    !inside(state.baseTree, absolute) ||
    (existsSync(absolute) &&
      !inside(realpathSync(state.baseTree), realpathSync(absolute)))
  )
    throw new ReviewError(`policy path escapes the base snapshot: ${path}`);
  return absolute;
}
async function policy(
  state: Session,
  script: string,
  args: string[],
  data = false,
  input?: string,
  extra: Record<string, string> = {},
): Promise<string> {
  return call(
    [
      process.execPath,
      "--no-env-file",
      `--config=${state.bunfig}`,
      ...(data
        ? ["--preload", join(dirname(state.files), "enter-reviewed.ts")]
        : []),
      script,
      ...args,
    ],
    {
      cwd: state.baseTree,
      env: { ...policyEnvironment(state), ...extra },
      reapGroup: true,
      ...(input === undefined ? {} : { stdin: input }),
    },
  );
}

interface SetupOptions {
  pr: string | undefined;
  files: string[] | undefined;
}
interface SessionFiles {
  directory: string;
  baseTree: string;
  files: string;
  emptyConfig: string;
}
function invalidSetupArgument(
  arg: string,
  index: number,
  end: number,
  prIndex: number,
): boolean {
  if (index >= end) return false;
  if (arg === "--pr") return false;
  return prIndex < 0 || index !== prIndex + 1;
}
function setupOptions(args: string[]): SetupOptions {
  const prIndex = args.indexOf("--pr");
  const pr =
    prIndex < 0 ? undefined : required(args[prIndex + 1], "--pr number");
  const fileIndex = args.indexOf("--files");
  if (
    args.some((arg, i) =>
      invalidSetupArgument(
        arg,
        i,
        fileIndex < 0 ? args.length : fileIndex,
        prIndex,
      ),
    )
  )
    throw new ReviewError("setup accepts --pr <number> and --files <paths...>");
  return { pr, files: fileIndex < 0 ? undefined : args.slice(fileIndex + 1) };
}
function createSessionFiles(root: string): SessionFiles {
  const directory = mkdtempSync(join(tmpdir(), "jig-review-"));
  const files = {
    directory,
    baseTree: join(directory, "base"),
    files: join(directory, "effective-files.nul"),
    emptyConfig: join(directory, "empty-bunfig.toml"),
  };
  writeFileSync(files.emptyConfig, "");
  writeFileSync(
    join(directory, "enter-reviewed.ts"),
    `process.chdir(${JSON.stringify(root)});\n`,
  );
  return files;
}
async function gh(root: string, ...args: string[]): Promise<string> {
  return call(["gh", ...args], {
    cwd: root,
    env: toolEnvironment(root),
  });
}
async function defaultBranch(root: string): Promise<string> {
  let branch: string;
  try {
    branch = (
      await git(
        root,
        "symbolic-ref",
        "--quiet",
        "--short",
        "refs/remotes/origin/HEAD",
      )
    )
      .trim()
      .replace(/^origin\//, "");
  } catch {
    branch = (
      await gh(
        root,
        "repo",
        "view",
        "--json",
        "defaultBranchRef",
        "-q",
        ".defaultBranchRef.name",
      )
    ).trim();
  }
  if (!branch) throw new ReviewError("cannot resolve the default branch");
  return branch;
}
function configuredBase(
  config: Record<string, unknown>,
  fallback: string,
): string {
  const repository = config.repository as { base_branch?: string } | undefined;
  return repository?.base_branch ?? fallback;
}
async function resolveBase(
  root: string,
  pr: string | undefined,
): Promise<string> {
  const branch = await defaultBranch(root);
  await git(root, "fetch", "origin", branch);
  const overlayPath = ".config/jig.yaml";
  const exists = (
    await git(
      root,
      "ls-tree",
      "--name-only",
      `origin/${branch}`,
      "--",
      overlayPath,
    )
  ).trim();
  const overlay = exists
    ? await git(root, "show", `origin/${branch}:${overlayPath}`)
    : null;
  const config = layeredConfig(root, { JIG_USER_LAYER: "off" }, overlay).values;
  return pr
    ? (
        await gh(
          root,
          "pr",
          "view",
          pr,
          "--json",
          "baseRefName",
          "-q",
          ".baseRefName",
        )
      ).trim()
    : configuredBase(config, branch);
}
async function collectFiles(
  root: string,
  base: string,
  explicit: string[] | undefined,
): Promise<string[]> {
  const mergeBase = (
    await git(root, "merge-base", `origin/${base}`, "HEAD")
  ).trim();
  const selected = explicit ?? [
    ...paths(
      await git(root, "diff", "--no-renames", "--name-only", "-z", mergeBase),
    ),
    ...paths(
      await git(root, "ls-files", "--others", "--exclude-standard", "-z"),
    ),
  ];
  for (const path of selected) validatePath(root, path);
  return [...new Set(selected)].sort(byCodeUnit);
}
function saveSession(
  root: string,
  base: string,
  files: SessionFiles,
  list: string[],
): void {
  writeFileSync(files.files, list.length ? `${list.join("\0")}\0` : "");
  const state: Session = {
    root,
    base,
    baseTree: files.baseTree,
    files: files.files,
    bunfig: existsSync(join(files.baseTree, "bunfig.toml"))
      ? join(files.baseTree, "bunfig.toml")
      : files.emptyConfig,
  };
  policyEnvironment(state);
  const session = join(files.directory, "session.json");
  writeFileSync(session, `${JSON.stringify(state)}\n`);
  console.log(JSON.stringify({ session, ...state }));
}
async function setup(args: string[]): Promise<void> {
  const options = setupOptions(args);
  const root = reviewedRoot();
  checkedHostEnvironment(root);
  const files = createSessionFiles(root);
  let attached = false;
  try {
    const base = await resolveBase(root, options.pr);
    await git(root, "fetch", "origin", base);
    await git(
      root,
      "worktree",
      "add",
      "--detach",
      files.baseTree,
      `origin/${base}`,
    );
    attached = true;
    saveSession(
      root,
      base,
      files,
      await collectFiles(root, base, options.files),
    );
  } catch (error) {
    if (attached)
      await git(root, "worktree", "remove", "--force", files.baseTree);
    rmSync(files.directory, { recursive: true, force: true });
    throw error;
  }
}
async function cleanup(state: Session): Promise<void> {
  await git(state.root, "worktree", "remove", "--force", state.baseTree);
  rmSync(resolve(state.files, ".."), { recursive: true, force: true });
}
function printFiles(state: Session): void {
  console.log(JSON.stringify(fileList(state)));
}
async function locateRules(state: Session): Promise<void> {
  process.stdout.write(
    await policy(
      state,
      resolve(import.meta.dir, "../../adr/scripts/locate.ts"),
      [],
    ),
  );
}
async function configuration(state: Session, args: string[]): Promise<void> {
  process.stdout.write(
    await policy(
      state,
      resolve(
        import.meta.dir,
        "../../resolve-review-comments/scripts/jig-config.ts",
      ),
      args,
    ),
  );
}
async function checkRules(state: Session, args: string[]): Promise<void> {
  const script = snapshotPath(
    state,
    required(args[0], "base-relative check script"),
  );
  const rules = snapshotPath(
    state,
    required(args[1], "base-relative rules file"),
  );
  const list = fileList(state).filter((file) =>
    statSync(join(state.root, file), { throwIfNoEntry: false })?.isFile(),
  );
  if (list.length)
    process.stdout.write(
      await policy(state, script, list, true, undefined, { RULES: rules }),
    );
}
async function runScript(state: Session, args: string[]): Promise<void> {
  const cwd = required(args[0], "snapshot or reviewed");
  if (cwd !== "snapshot" && cwd !== "reviewed")
    throw new ReviewError("run location must be snapshot or reviewed");
  const script = snapshotPath(state, required(args[1], "base-relative script"));
  process.stdout.write(
    await policy(state, script, args.slice(2), cwd === "reviewed"),
  );
}
interface CatalogPolicy {
  validation_plan_command?: string;
  change_areas_catalog?: string;
}
function catalogPolicy(state: Session): CatalogPolicy {
  const config = layeredConfig(state.baseTree, policyEnvironment(state)).values;
  return (config.drive as CatalogPolicy | undefined) ?? {};
}
function reportCatalogChanged(
  catalog: string | undefined,
  list: string[],
): void {
  if (catalog && list.includes(catalog)) console.error("catalog_changed");
}
async function validationPlan(
  state: Session,
  command: string,
  list: string[],
): Promise<void> {
  const input = list.length ? `${list.join("\n")}\n` : "";
  process.stdout.write(
    await policy(
      state,
      join(import.meta.dir, "policy-shell.ts"),
      [command],
      false,
      input,
    ),
  );
}
async function nativeCatalog(state: Session): Promise<void> {
  process.stdout.write(
    await policy(
      state,
      resolve(import.meta.dir, "../../change-areas/scripts/resolve.ts"),
      ["--files", "-", "-z", "--format", "json", "--no-validation"],
      false,
      readFileSync(state.files, "utf8"),
    ),
  );
}
async function resolveCatalog(state: Session): Promise<void> {
  const drive = catalogPolicy(state);
  const list = fileList(state);
  reportCatalogChanged(drive.change_areas_catalog, list);
  if (drive.validation_plan_command)
    await validationPlan(state, drive.validation_plan_command, list);
  else if (drive.change_areas_catalog) await nativeCatalog(state);
  else
    console.log(
      JSON.stringify({ reviewSkills: [], postDeploy: [], catalog: null }),
    );
}
function printPatterns(state: Session): void {
  for (const file of fileList(state)) {
    if (!statSync(join(state.root, file), { throwIfNoEntry: false })?.isFile())
      continue;
    readFileSync(join(state.root, file), "utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (/console\.log\(|: any|as any/.test(line))
          console.log(`${file}:${i + 1}:${line}`);
      });
  }
}
async function printTrailers(state: Session): Promise<void> {
  const output = await git(
    state.root,
    "log",
    "--format=%h %(trailers:key=Ratchet-Loosen,valueonly,separator=%x2C )",
    `origin/${state.base}..HEAD`,
  );
  for (const line of output.split("\n"))
    if (line && !/^[0-9a-f]+\s*$/.test(line)) console.log(line);
}
const operations: Record<
  string,
  (state: Session, args: string[]) => void | Promise<void>
> = {
  cleanup,
  files: printFiles,
  locate: locateRules,
  config: configuration,
  check: checkRules,
  run: runScript,
  catalog: resolveCatalog,
  patterns: printPatterns,
  trailers: printTrailers,
};
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "setup") return setup(args);
  const [session, ...operationArgs] = args;
  const state = readState(required(session, "session file"));
  const operation = operations[command ?? ""];
  if (!operation)
    throw new ReviewError(
      "expected setup, files, locate, config, check, run, catalog, patterns, trailers or cleanup",
    );
  await operation(state, operationArgs);
}
if (import.meta.main)
  main().catch((error) => {
    console.error(`review: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
