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
import {
  changedPaths,
  effectiveDiff,
  type Git,
  gitVersionProblem,
  nulSeparated,
  requireExisting,
} from "./effective-diff.ts";
import { instructionFiles, lensBrief } from "./lens-brief.ts";
import { parseLens, realInside } from "./lens-file.ts";
import { renderSelection, type Selection } from "./lens-selection.ts";

class ReviewError extends Error {
  override name = "ReviewError";
}

interface Session {
  root: string;
  remote: string;
  base: string;
  baseTree: string;
  files: string;
  diff: string;
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
function assertCompleted(
  child: RunResult,
  label: string,
  accept: readonly number[] = [0],
): void {
  if (!accept.includes(child.code) || child.signal !== undefined)
    throw new ReviewError(`${label} failed: ${childFailureOutput(child)}`);
  if (child.groupSurvived)
    throw new ReviewError(
      `${label} left unfinished descendants; cancelled them instead of accepting the result`,
    );
}
function childFailureOutput(child: RunResult): string {
  return child.stderr || child.stdout || String(child.code);
}
async function execute(
  argv: string[],
  options: RunOptions,
  accept: readonly number[] = [0],
): Promise<RunResult> {
  const child = await withoutTracePropagation(() =>
    run(argv, { timeoutSec: 60, ...options }),
  );
  assertCompleted(child, `${argv[0] ?? ""} ${argv[1] ?? ""}`, accept);
  if (child.stderr) process.stderr.write(child.stderr);
  return child;
}
async function call(argv: string[], options: RunOptions): Promise<string> {
  return (await execute(argv, options)).stdout;
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
  return (await gitIn(root)(args, [0])).stdout;
}
/** Git in the reviewed tree, accepting the exit statuses each call names. */
function gitIn(root: string): Git {
  return (args, accept) =>
    execute(
      ["git", ...args],
      { cwd: root, env: toolEnvironment(root) },
      accept,
    );
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
    remote:
      value.remote === undefined ? "origin" : field(value, "remote", isString),
    base: field(value, "base", isString),
    baseTree: field(value, "baseTree", isString),
    files: field(value, "files", isString),
    diff: field(value, "diff", isString),
    bunfig: field(value, "bunfig", isString),
  };
}
function fileList(state: Session): string[] {
  const list = nulSeparated(readFileSync(state.files, "utf8"));
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
  base: string | undefined;
  remote: string | undefined;
  files: string[] | undefined;
}
interface SessionFiles {
  directory: string;
  baseTree: string;
  files: string;
  diff: string;
  emptyConfig: string;
}
const SETUP_USAGE =
  "setup accepts --pr <number> or --base <branch>, optionally --remote <name>, then --files <paths...>";
const SETUP_FLAGS: Record<string, "pr" | "base" | "remote"> = {
  "--pr": "pr",
  "--base": "base",
  "--remote": "remote",
};
/** The flags before `--files`, and the paths after it. */
function splitFiles(args: string[]): {
  flags: string[];
  files: string[] | undefined;
} {
  const at = args.indexOf("--files");
  return at < 0
    ? { flags: args, files: undefined }
    : { flags: args.slice(0, at), files: args.slice(at + 1) };
}
function setupFlag(
  flag: string | undefined,
  given: string | undefined,
): ["pr" | "base" | "remote", string] {
  const key = SETUP_FLAGS[String(flag)];
  const value = required(given, `${flag} value`);
  if (key === undefined || value.startsWith("-"))
    throw new ReviewError(SETUP_USAGE);
  return [key, value];
}
function setupOptions(args: string[]): SetupOptions {
  const { flags, files } = splitFiles(args);
  const options: SetupOptions = {
    pr: undefined,
    base: undefined,
    remote: undefined,
    files,
  };
  for (let i = 0; i < flags.length; i += 2) {
    const [key, value] = setupFlag(flags[i], flags[i + 1]);
    options[key] = value;
  }
  if (options.pr !== undefined && options.base !== undefined)
    throw new ReviewError(SETUP_USAGE);
  return options;
}
function createSessionFiles(root: string): SessionFiles {
  const directory = mkdtempSync(join(tmpdir(), "jig-review-"));
  const files = {
    directory,
    baseTree: join(directory, "base"),
    files: join(directory, "effective-files.nul"),
    diff: join(directory, "effective.diff"),
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
async function defaultBranch(root: string, remote: string): Promise<string> {
  let branch: string;
  try {
    branch = (
      await git(
        root,
        "symbolic-ref",
        "--quiet",
        "--short",
        `refs/remotes/${remote}/HEAD`,
      )
    )
      .trim()
      .replace(`${remote}/`, "");
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
  remote: string,
  pr: string | undefined,
): Promise<string> {
  const branch = await defaultBranch(root, remote);
  await git(root, "fetch", remote, branch);
  const overlayPath = ".config/jig.yaml";
  const exists = (
    await git(
      root,
      "ls-tree",
      "--name-only",
      `${remote}/${branch}`,
      "--",
      overlayPath,
    )
  ).trim();
  const overlay = exists
    ? await git(root, "show", `${remote}/${branch}:${overlayPath}`)
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
interface EffectiveChange {
  list: string[];
  diff: string;
}
function distinctSorted(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort(byCodeUnit);
}
/**
 * The effective file list and diff. Explicit files are each compared with
 * nothing, so every line counts as added; otherwise every change since the
 * merge base, committed, staged, unstaged and untracked.
 */
async function collectChange(
  root: string,
  remote: string,
  base: string,
  explicit: string[] | undefined,
): Promise<EffectiveChange> {
  const mergeBase = (
    await git(root, "merge-base", `${remote}/${base}`, "HEAD")
  ).trim();
  if (explicit) {
    for (const path of explicit) validatePath(root, path);
    requireExisting(root, explicit);
    const list = distinctSorted(explicit);
    return {
      list,
      diff: await effectiveDiff(gitIn(root), mergeBase, [], list),
    };
  }
  const { tracked, untracked } = await changedPaths(gitIn(root), mergeBase);
  for (const path of [...tracked, ...untracked]) validatePath(root, path);
  return {
    list: distinctSorted([...tracked, ...untracked]),
    diff: await effectiveDiff(gitIn(root), mergeBase, tracked, untracked),
  };
}
function saveSession(
  root: string,
  remote: string,
  base: string,
  files: SessionFiles,
  change: EffectiveChange,
): void {
  const list = change.list;
  writeFileSync(files.files, list.length ? `${list.join("\0")}\0` : "");
  writeFileSync(files.diff, change.diff);
  const state: Session = {
    root,
    remote,
    base,
    baseTree: files.baseTree,
    files: files.files,
    diff: files.diff,
    bunfig: existsSync(join(files.baseTree, "bunfig.toml"))
      ? join(files.baseTree, "bunfig.toml")
      : files.emptyConfig,
  };
  policyEnvironment(state);
  const session = join(files.directory, "session.json");
  writeFileSync(session, `${JSON.stringify(state)}\n`);
  console.log(JSON.stringify({ session, ...state }));
}
/** Stop before anything is created when git cannot pin the diff's attributes. */
async function requireGitVersion(root: string): Promise<void> {
  const problem = gitVersionProblem(await git(root, "--version"));
  if (problem) throw new ReviewError(problem);
}
async function setup(args: string[]): Promise<void> {
  const options = setupOptions(args);
  const root = reviewedRoot();
  checkedHostEnvironment(root);
  await requireGitVersion(root);
  const files = createSessionFiles(root);
  let attached = false;
  try {
    const remote = options.remote ?? "origin";
    const base = options.base ?? (await resolveBase(root, remote, options.pr));
    await git(root, "fetch", remote, base);
    await git(
      root,
      "worktree",
      "add",
      "--detach",
      files.baseTree,
      `${remote}/${base}`,
    );
    attached = true;
    saveSession(
      root,
      remote,
      base,
      files,
      await collectChange(root, remote, base, options.files),
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
  // A link among a path's components can lead outside the repository, so
  // each file is kept only when its real location is inside the real root.
  const reviewedRoot = realpathSync(state.root);
  const list = fileList(state).filter((file) => {
    const path = join(state.root, file);
    return (
      statSync(path, { throwIfNoEntry: false })?.isFile() === true &&
      inside(reviewedRoot, realpathSync(path))
    );
  });
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
    `${state.remote}/${state.base}..HEAD`,
  );
  for (const line of output.split("\n"))
    if (line && !/^[0-9a-f]+\s*$/.test(line)) console.log(line);
}
/** Where the lens step keeps the selection the briefs are written from. */
function selectionFile(state: Session): string {
  return join(dirname(state.files), "lenses.json");
}
function isSelection(value: unknown): value is Selection {
  return isRecord(value) && Array.isArray(value.lenses);
}
/**
 * Select the lenses inside the base snapshot, keep the selection for the
 * briefs, and print one line per lens. A configuration error stops here.
 */
async function selectLenses(state: Session, args: string[]): Promise<void> {
  if (args.some((arg) => !/^--lens=.+$/.test(arg)))
    throw new ReviewError("lenses accepts only --lens=<id>");
  const json = await policy(state, join(import.meta.dir, "select-lenses.ts"), [
    state.files,
    state.diff,
    "--json",
    ...args,
  ]);
  const selection = decodeJson(json, isSelection, "select-lenses output");
  writeFileSync(selectionFile(state), json);
  process.stdout.write(renderSelection(selection));
}
/** Write the brief one selected lens's reviewer runs from, and print its path. */
function writeBrief(state: Session, args: string[]): void {
  const id = required(args[0], "lens id");
  if (!existsSync(selectionFile(state)))
    throw new ReviewError(
      "select the lenses first: review.ts lenses <session>",
    );
  const selection = decodeJson(
    readFileSync(selectionFile(state), "utf8"),
    isSelection,
    "the saved lens selection",
  );
  const chosen = selection.lenses.find((lens) => lens.id === id && lens.runs);
  if (!chosen) throw new ReviewError(`${id} is not a lens this selection runs`);
  if (
    chosen.source === "repository" &&
    !realInside(state.baseTree, chosen.file)
  )
    throw new ReviewError(`lens file leaves the base snapshot: ${chosen.file}`);
  const lensText = readFileSync(chosen.file, "utf8");
  const lens = parseLens(lensText, chosen.file, chosen.source);
  const list = fileList(state);
  const brief = lensBrief({
    label: `${lens.id}@${lens.version}`,
    lensText,
    evidence: lens.evidence,
    reviewedRoot: state.root,
    touched: list
      .map((file) => join(state.root, file))
      .filter((path) => existsSync(path) && realInside(state.root, path)),
    instructions: instructionFiles(state.baseTree, list),
    diff: readFileSync(state.diff, "utf8"),
    earlier: args[1] === undefined ? null : readFileSync(args[1], "utf8"),
  });
  const path = join(dirname(state.files), `brief-${lens.id}.md`);
  writeFileSync(path, brief);
  console.log(path);
}
/** How long one lens's agent run may take before it is cancelled. */
const AGENT_DEADLINE_SECONDS = 1800;
/**
 * Run one brief through the harness's agent command, started inside the
 * base snapshot with the enumerated environment, the brief on its stdin.
 */
async function runAgent(state: Session, args: string[]): Promise<void> {
  const brief = required(args[0], "brief file");
  const command = args.slice(1);
  required(command[0], "agent command");
  const child = await execute(command, {
    cwd: state.baseTree,
    env: policyEnvironment(state),
    stdin: readFileSync(brief, "utf8"),
    reapGroup: true,
    timeoutSec: AGENT_DEADLINE_SECONDS,
  });
  process.stdout.write(child.stdout);
}
const operations: Record<
  string,
  (state: Session, args: string[]) => void | Promise<void>
> = {
  lenses: selectLenses,
  brief: writeBrief,
  agent: runAgent,
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
      "expected setup, files, locate, config, check, run, catalog, patterns, trailers, lenses, brief, agent or cleanup",
    );
  await operation(state, operationArgs);
}
if (import.meta.main)
  main().catch((error) => {
    console.error(`review: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
