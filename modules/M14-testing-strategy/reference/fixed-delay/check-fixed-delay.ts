#!/usr/bin/env bun
// Poll, don't sleep: every fixed delay in the files scanned carries a
// `fixed-delay: <reason>` token, and every token sits beside a delay.
//
// A wait for external state (a job to finish, a row to appear) polls against
// a deadline. A fixed delay is allowed only for local timing (a retry
// back-off, an abort deadline, the pause between two polls), and says so with
// the token on its own line or the line above. The token is an exception, so
// it prunes itself: one with no delay on its line or the line below excuses
// nothing, and fails, so it leaves with the delay it excused instead of
// waiting beside the next one written there.
//
// What counts as a delay is a list of literal texts (`--pattern`, repeatable;
// by default `Bun.sleep(`, `setTimeout(`, `sleep(` and `time.sleep(`). A text
// matches where the character before it is not part of a name in any script,
// so `sleep(` finds `sleep(` and `asyncio.sleep(` but not `oversleep(` or
// `résleep(`; the token is matched the same way. The gate reads
// text, not code: a delay named in a comment or a string counts too.
//
// Files are named as arguments: a path, a directory (every file under it), or
// a glob read from `--root` (default `.`). A directory or glob leaves out
// `.git` and `node_modules`, and `--exclude <glob>` (repeatable, relative to
// `--root`) leaves out more. Binary files are skipped.
//
// Exit codes: 0 every delay carries a token with a reason and every token sits
// beside a delay; 1 findings, each with its file and line, problem and fix: a
// delay without a token, a token without a reason, or a token with no delay
// on its line or the line below; 2 could not check: a usage error (no file
// named, an empty pattern, an unknown option), an argument that matches no
// file, a file that cannot be read, or nothing left to scan. A run that
// examined nothing never passes. Under GitHub Actions each finding is also
// printed as an `::error` annotation.
//
// Self-contained: no imports beyond Bun and Node's built-ins, so the file can
// be copied into a repository as it is.
//
// Usage:
//   bun check-fixed-delay.ts 'src/**/*.test.ts' 'scripts/**/*.ts' \
//     --exclude '**/fixtures/**'
import { readdirSync, readFileSync, statSync } from "node:fs";
import { posix, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

const RULE = "fixed-delay";
export const DEFAULT_PATTERNS = [
  "Bun.sleep(",
  "setTimeout(",
  "sleep(",
  "time.sleep(",
];
const SKIPPED_DIRS = new Set([".git", "node_modules"]);
const USAGE =
  "usage: check-fixed-delay.ts [--pattern <text>]... [--exclude <glob>]... [--root <dir>] <path|dir|glob>...";

// A character that can continue a name in any script: `résleep(` and
// `éfixed-delay:` are names, not a delay or a token. Used with the `u` flag.
const NAME_CHAR = String.raw`\p{ID_Continue}$`;
const TOKEN = new RegExp(`(?<![${NAME_CHAR}-])fixed-delay:`, "u");
// `--!>` closes an HTML comment as `-->` does.
const BLOCK_COMMENT_END = /\*\/|--!?>/;
const POLL =
  "wait for the state with a polling helper and a deadline; for local timing (a back-off, an abort deadline, the pause between polls) add `fixed-delay: <reason>` on the line or the line above";

type Env = Record<string, string | undefined>;

/** The gate could not decide: a usage error, or nothing it could scan (exit 2). */
class CouldNotCheck extends Error {
  override name = "CouldNotCheck";
}

interface Finding {
  file: string;
  line: number;
  problem: string;
  remedy: string;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A matcher for a delay text where the character before it is not part of a name. */
export function delayPattern(text: string): RegExp {
  return new RegExp(`(?<![${NAME_CHAR}])${escapeRegExp(text)}`, "u");
}

/**
 * The reason of every token on the line: the text after each, up to the next
 * token or a block comment's closing marker; null when the line has none.
 */
function tokenReasons(line: string): string[] | null {
  const parts = line.split(TOKEN);
  if (parts.length < 2) return null;
  return parts
    .slice(1)
    .map((text) => text.split(BLOCK_COMMENT_END)[0]?.trim() ?? "");
}

/** The findings in one file's lines, and how many delays it holds. */
export function lineFindings(
  file: string,
  lines: string[],
  patterns: RegExp[],
): { findings: Finding[]; delays: number } {
  const delay = lines.map((text) => patterns.some((p) => p.test(text)));
  const reason = lines.map(tokenReasons);
  const findings: Finding[] = [];
  const at = (index: number, problem: string, remedy: string) =>
    findings.push({ file, line: index + 1, problem, remedy });
  reason.forEach((texts, i) => {
    if (texts === null) return;
    if (!delay[i] && !delay[i + 1])
      at(
        i,
        "`fixed-delay:` with no delay on its line or the line below excuses nothing",
        "delete the token, or move it onto the delay it excuses or the line above",
      );
    else if (texts.some((text) => !text))
      at(
        i,
        "`fixed-delay:` without a reason does not excuse the delay",
        "say after the token why this delay must be fixed",
      );
  });
  delay.forEach((isDelay, i) => {
    if (isDelay && reason[i] == null && reason[i - 1] == null)
      at(i, "fixed delay without a `fixed-delay: <reason>` token", POLL);
  });
  findings.sort((a, b) => a.line - b.line);
  return { findings, delays: delay.filter(Boolean).length };
}

const skipped = (path: string) =>
  path.split("/").some((segment) => SKIPPED_DIRS.has(segment));

/** Every file under a directory, relative to it, links not followed. */
function* walk(root: string, dir = ""): Generator<string> {
  for (const entry of readdirSync(posix.join(root, dir), {
    withFileTypes: true,
  })) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* walk(root, path);
    } else if (entry.isFile()) yield path;
  }
}

/** The files one argument names: a path, a directory or a glob. */
function filesOf(arg: string, root: string): string[] {
  const stat = statSync(arg, { throwIfNoEntry: false });
  if (stat?.isFile()) return [arg];
  if (stat?.isDirectory())
    return [...walk(arg)].map((path) => posix.join(arg, path));
  const glob = new Bun.Glob(arg);
  return [...glob.scanSync({ cwd: root, onlyFiles: true })]
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !skipped(path))
    .map((path) => (root === "." ? path : posix.join(root, path)));
}

interface Options {
  files: string[];
  patterns: string[];
}

/** The parsed arguments; an unknown option or a missing value is a usage error. */
function readArgs(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        pattern: { type: "string", multiple: true },
        exclude: { type: "string", multiple: true, default: [] },
        root: { type: "string", default: "." },
      },
    });
  } catch (error) {
    throw new CouldNotCheck(
      `${error instanceof Error ? error.message : String(error)}\n${USAGE}`,
    );
  }
}

function parseOptions(argv: string[]): Options {
  const { values, positionals } = readArgs(argv);
  if (!positionals.length)
    throw new CouldNotCheck(`name the files to scan\n${USAGE}`);
  const patterns = values.pattern ?? DEFAULT_PATTERNS;
  if (patterns.some((text) => !text.trim()))
    throw new CouldNotCheck(`--pattern must not be empty\n${USAGE}`);
  if (positionals.some((arg) => !arg.trim()))
    throw new CouldNotCheck(`a file argument must not be empty\n${USAGE}`);
  const excludes = values.exclude.map((glob) => new Bun.Glob(glob));
  const root = resolve(values.root);
  const files = new Set<string>();
  for (const arg of positionals) {
    const found = filesOf(arg, values.root);
    if (!found.length) throw new CouldNotCheck(`${arg} matches no file`);
    for (const file of found) {
      const fromRoot = relative(root, resolve(file)).replaceAll("\\", "/");
      if (!excludes.some((glob) => glob.match(fromRoot))) files.add(file);
    }
  }
  return { files: [...files].sort(), patterns };
}

/** Workflow-command escaping for a message, and for a property. */
const escapeData = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (text: string) =>
  escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

function report(findings: Finding[], env: Env): void {
  for (const f of findings)
    console.error(
      `${f.file}:${f.line}: [${RULE}] ${f.problem}\n  fix: ${f.remedy}`,
    );
  if (env.GITHUB_ACTIONS === "true")
    for (const f of findings)
      console.log(
        `::error file=${escapeProperty(f.file)},line=${f.line},title=${RULE}::${escapeData(`${f.problem} Fix: ${f.remedy}`)}`,
      );
}

export function checkFixedDelay(
  argv: string[],
  env: Env = process.env,
): number {
  const { files, patterns } = parseOptions(argv);
  const matchers = patterns.map(delayPattern);
  const findings: Finding[] = [];
  let scanned = 0;
  let delays = 0;
  for (const file of files) {
    const content = readFileSync(file);
    if (content.includes(0)) continue;
    scanned++;
    const lines = content.toString("utf8").split(/\r?\n/);
    const result = lineFindings(file, lines, matchers);
    findings.push(...result.findings);
    delays += result.delays;
  }
  if (!scanned)
    throw new CouldNotCheck(
      `${RULE}: could not check: no text file left to scan in ${files.length} file(s) named`,
    );
  if (findings.length) {
    report(findings, env);
    console.error(
      `${RULE}: ${findings.length} finding(s) in ${scanned} text file(s)`,
    );
    return 1;
  }
  console.log(
    `OK — ${RULE}: ${scanned} text file(s), ${delays} line(s) with a fixed delay, each with a justified fixed-delay token, and every token beside a delay. Matches the text ${patterns.join(" ")} only, in code, comments and strings alike; a delay written another way is not seen.`,
  );
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = checkFixedDelay(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    if (process.env.GITHUB_ACTIONS === "true")
      console.log(
        `::error title=${RULE}%3A could not check::${escapeData(message)}`,
      );
    process.exitCode = 2;
  }
}
