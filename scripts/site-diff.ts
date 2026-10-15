// Scope: what a change did to the jig-harness.dev website's content. The site
// renders the repository's documents at build time (design/website.md), so
// which pages a change reached is a fact of the build, not of the changed
// paths: this builds the site at two commits, each in a temporary worktree,
// and compares the text of every page's main content, in order, with each
// heading's level and each link's and image's target. The header and footer
// (the plugin version, the navigation) are left out: they change on every
// release and say nothing about the change.
//
// Building a commit runs its code (the install and the site's build scripts)
// with the caller's credentials: build only commits whose diff you would run
// the gates on.
//
// Usage: bun site-diff.ts <base-ref> <head-ref> [--lines <n>] [--json] [--keep]
//   For a merged pull request: `<merge-sha>^1 <merge-sha>`.
//   --lines  the added and removed lines shown per page (default 6)
//   --keep   leave the temporary worktrees, to open the built pages
// Each build installs the locked dependencies (root and website/) and runs
// `bun run build` in website/, a minute or two per commit. A step that runs
// past STEP_TIMEOUT_MS is stopped with every process it started. An
// interrupt or a kill ends the run without its cleanup, since the repository
// keeps process signal handlers in one place and this script installs none:
// `git worktree list` then shows the `jig-site-diff.*` worktrees, each removed
// with `git worktree remove --force <dir>`.
// Exit: 0 no page changed, 1 pages were added, removed or changed, 2 a usage
// error or a failed build.
import type { ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { cli } from "../lib/cli.ts";
import { LEAKY_GIT_ENV, spawn, spawnSync } from "../lib/guarded-git-spawn.ts";

/** Elements whose start begins a new line of text. */
const BLOCK =
  /^(address|article|aside|blockquote|br|caption|dd|details|div|dl|dt|figcaption|figure|h[1-6]|header|hr|li|nav|ol|p|pre|section|summary|table|td|th|tr|ul)$/;

/**
 * The text of a page's `<main>`, one block per line, scripts and styles left
 * out. Every element boundary separates words, so a label and its value
 * (`<b>Level</b><i>Lite</i>`) read as two. A heading opens with its level
 * (`## Title`), a link ends with its target (`Read (/x)`) and an image
 * reads `[image: alt (src)]`, so a changed level, target or picture is a
 * changed line.
 */
function opening(
  tag: string,
  attr: (name: string) => string | null,
  shown: boolean,
): string {
  // A new block starts a line; any other element at least a word.
  const start = BLOCK.test(tag) ? "\n" : " ";
  const level = /^h([1-6])$/.exec(tag)?.[1];
  if (level && shown) return `${start}${"#".repeat(Number(level))} `;
  if (tag === "img" && shown)
    return `${start}[image: ${attr("alt") ?? ""} (${attr("src") ?? ""})] `;
  return start;
}

export function pageText(html: string): string[] {
  let inMain = false;
  let skip = 0;
  let text = "";
  new HTMLRewriter()
    .on("main", {
      element(el) {
        inMain = true;
        el.onEndTag(() => {
          inMain = false;
        });
      },
    })
    .on("script, style, template", {
      element(el) {
        skip++;
        el.onEndTag(() => {
          skip--;
        });
      },
    })
    .on("*", {
      element(el) {
        if (!inMain) return;
        text += opening(el.tagName, (name) => el.getAttribute(name), !skip);
        const href = el.tagName === "a" ? el.getAttribute("href") : null;
        if (href !== null)
          el.onEndTag(() => {
            if (!skip) text += ` (${href})`;
          });
      },
      text(t) {
        // Whitespace in the source is a space; only a block starts a line.
        if (inMain && !skip) text += t.text.replace(/\s+/g, " ");
      },
    })
    .transform(html);
  return text
    .split("\n")
    .map((line) => line.replace(/ +/g, " ").trim())
    .filter(Boolean);
}

/** A built file's route: `modules/M2/index.html` -> `/modules/M2/`. */
export function routeOf(file: string): string {
  const path = file.split(sep).join("/");
  if (path === "index.html") return "/";
  if (path.endsWith("/index.html")) return `/${path.slice(0, -10)}`;
  return `/${path}`;
}

export interface PageChange {
  route: string;
  removed: string[];
  added: string[];
}

export interface SiteDiff {
  added: string[];
  removed: string[];
  changed: PageChange[];
}

/** `a` and `b` without the lines they share at both ends. */
function trimCommon(a: string[], b: string[]): [string[], string[]] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  )
    end++;
  return [a.slice(start, a.length - end), b.slice(start, b.length - end)];
}

/**
 * The most edits the line diff searches for. The search keeps a row per edit
 * as wide as the edits so far, so its memory grows with the square of this
 * (about 16 MB here); past it, a page reads as rewritten.
 */
export const MAX_EDITS = 2000;

/** The furthest x on each diagonal `-d..d`, before edit `d`; `at(k)` reads diagonal `k`. */
type Row = { d: number; v: Int32Array };
const at = (row: Row, k: number) => Number(row.v[row.d + k]);

/** Whether the furthest path on diagonal `k` after `d` edits came down (an insertion). */
function cameDown(row: Row, k: number, d: number): boolean {
  return k === -d || (k !== d && at(row, k - 1) < at(row, k + 1));
}

/** How far a path reaches on diagonal `k` with `d` edits, following the shared lines. */
function furthest(
  a: string[],
  b: string[],
  row: Row,
  k: number,
  d: number,
): number {
  let x = cameDown(row, k, d) ? at(row, k + 1) : at(row, k - 1) + 1;
  while (x < a.length && x - k < b.length && a[x] === b[x - k]) x++;
  return x;
}

/**
 * Myers' forward search: the furthest-reaching paths before each edit count,
 * each row only as wide as the diagonals it can reach. Null past `MAX_EDITS`.
 */
function editTrace(a: string[], b: string[]): Row[] | null {
  const off = a.length + b.length + 1;
  const v = new Int32Array(2 * off + 1);
  const trace: Row[] = [];
  for (let d = 0; d <= a.length + b.length; d++) {
    if (d > MAX_EDITS) return null;
    const row = { d, v: v.slice(off - d, off + d + 1) };
    trace.push(row);
    for (let k = -d; k <= d; k += 2) {
      const x = furthest(a, b, row, k, d);
      v[off + k] = x;
      if (x >= a.length && x - k >= b.length) return trace;
    }
  }
  return trace;
}

/**
 * The lines removed from `a` and added in `b`, in order: a shortest edit
 * script (Myers), so a line that moved is removed where it was and added
 * where it is. Past `MAX_EDITS` every line between the shared ends counts as
 * removed and added.
 */
export function lineDiff(
  before: string[],
  after: string[],
): { removed: string[]; added: string[] } {
  const [a, b] = trimCommon(before, after);
  const trace = editTrace(a, b);
  if (!trace) return { removed: a, added: b };
  const removed: string[] = [];
  const added: string[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d > 0; d--) {
    const row = trace[d] as Row;
    const k = x - y;
    const prev = cameDown(row, k, d) ? k + 1 : k - 1;
    x = at(row, prev);
    y = x - prev;
    if (prev === k + 1) added.push(String(b[y]));
    else removed.push(String(a[x]));
  }
  return { removed: removed.reverse(), added: added.reverse() };
}

/** Pages by route, before and after, compared line by line. */
export function diffSites(
  before: Map<string, string[]>,
  after: Map<string, string[]>,
): SiteDiff {
  const routes = (m: Map<string, string[]>) => [...m.keys()].sort();
  const changed: PageChange[] = [];
  for (const route of routes(after)) {
    const old = before.get(route);
    if (!old) continue;
    const now = after.get(route) ?? [];
    const { removed, added } = lineDiff(old, now);
    if (removed.length || added.length) changed.push({ route, removed, added });
  }
  return {
    added: routes(after).filter((r) => !before.has(r)),
    removed: routes(before).filter((r) => !after.has(r)),
    changed,
  };
}

/** Every built page under `dist`, by route. */
export function builtPages(dist: string): Map<string, string[]> {
  const pages = new Map<string, string[]>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(".html"))
        pages.set(
          routeOf(relative(dist, path)),
          pageText(readFileSync(path, "utf8")),
        );
    }
  };
  visit(dist);
  return pages;
}

/** The longest an install or a build may run before it is stopped. */
const STEP_TIMEOUT_MS = 15 * 60_000;

/**
 * How long a stopped step has to close its output before it is given up on:
 * a process the stop could not reach can hold the output open forever.
 */
const STOP_GRACE_MS = 10_000;

/** The end of a step's error output kept for its failure message. */
const TAIL_CHARS = 2000;

/** The most output a step whose output is read may print. */
const OUTPUT_LIMIT_CHARS = 1_000_000;

const ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
  ),
);

/** `root` and every process below it, from a `ps -A -o pid=,ppid=` listing. */
export function processTree(root: number, listing: string): number[] {
  const children = new Map<number, number[]>();
  for (const line of listing.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid !== undefined)
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree = [root];
  for (let i = 0; i < tree.length; i++)
    tree.push(...(children.get(tree[i] as number) ?? []));
  return tree;
}

function kill(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * Stops a step and every process it started. A step stays in the caller's
 * process group, so an interrupt at the terminal reaches all of them; the
 * deadline has to find them, since `bun run` leaves its script running when
 * it is killed. Returns why the processes it started could not be listed or
 * stopped, or null. It cannot see a process that has already left the
 * step's tree (its parent exited first).
 */
function stop(child: ChildProcess): string | null {
  if (!child.pid) return null;
  return process.platform === "win32"
    ? stopWindows(child.pid)
    : stopPosix(child.pid);
}

/** Why a helper command failed, or null when it succeeded. */
function failedBecause(
  result: ReturnType<typeof spawnSync>,
  what: string,
): string | null {
  if (result.status === 0) return null;
  return `${what}: ${String(result.stderr || result.error || "").trim()}`;
}

function stopWindows(pid: number): string | null {
  const taskkill = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
    env: ENV,
    timeout: 30_000,
  });
  return failedBecause(taskkill, "taskkill failed");
}

function stopPosix(pid: number): string | null {
  const ps = spawnSync("ps", ["-A", "-o", "pid=,ppid="], {
    env: ENV,
    timeout: 30_000,
  });
  const failed = failedBecause(
    ps,
    "ps failed, so only the step itself was stopped",
  );
  for (const each of processTree(pid, failed ? "" : String(ps.stdout ?? "")))
    kill(each);
  return failed;
}

/** `text` with `chunk` appended, cut to its last `limit` characters. */
function tail(text: string, chunk: string, limit: number): string {
  const all = text + chunk;
  return all.length > limit ? all.slice(-limit) : all;
}

export interface RunOptions {
  /** Return what the step printed (at most `OUTPUT_LIMIT_CHARS`); otherwise it is drained. */
  output?: boolean;
  timeoutMs?: number;
}

/**
 * Runs a step and settles within `timeoutMs` plus `STOP_GRACE_MS`, whatever
 * the processes it started do. It resolves only when the step exits 0 before
 * its deadline; a step that reached its deadline is a failure however it then
 * exits, and a stop that throws is reported, not raised. Only the end of its
 * error output is kept.
 */
export function run(
  cmd: string[],
  cwd: string,
  { output = false, timeoutMs = STEP_TIMEOUT_MS }: RunOptions = {},
): Promise<string> {
  const [command = "", ...args] = cmd;
  const failure = (why: string) =>
    new Error(`${cmd.join(" ")} (in ${cwd}) failed: ${why}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: ENV,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let done = false;
    let expired = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
    };
    child.stdout?.on("data", (chunk) => {
      if (!output) return;
      if (stdout.length + String(chunk).length > OUTPUT_LIMIT_CHARS)
        overflow = true;
      else stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr = tail(stderr, String(chunk), TAIL_CHARS);
    });
    const timer = setTimeout(() => {
      expired = true;
      let unstopped: string | null;
      try {
        unstopped = stop(child);
      } catch (error) {
        unstopped = `the stop failed: ${String(error)}`;
      }
      stderr = tail(
        stderr,
        `\nstopped after ${timeoutMs / 60_000} minutes${unstopped ? `; ${unstopped}` : ""}`,
        TAIL_CHARS,
      );
      grace = setTimeout(() => {
        if (done) return;
        settle();
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        reject(
          failure(
            `${stderr.trim()}\nits output stayed open ${STOP_GRACE_MS / 1000} s after the stop: a process it started may still be running`,
          ),
        );
      }, STOP_GRACE_MS);
    }, timeoutMs);
    child.on("error", (error) => {
      if (done) return;
      settle();
      reject(error);
    });
    child.on("close", (code) => {
      if (done) return;
      settle();
      if (overflow)
        reject(failure(`printed more than ${OUTPUT_LIMIT_CHARS} characters`));
      else if (code === 0 && !expired) resolve(stdout);
      else reject(failure(stderr.trim()));
    });
  });
}

/**
 * Builds the site at `ref` in a worktree under `scratch`, recording the
 * worktree in `made` before it is created, since a failed or stopped
 * `git worktree add` can leave it registered; returns its pages.
 */
async function buildAt(
  root: string,
  scratch: string,
  name: string,
  ref: string,
  made: string[],
): Promise<Map<string, string[]>> {
  const dir = join(scratch, name);
  made.push(dir);
  await run(["git", "worktree", "add", "--detach", dir, ref], root);
  await run(["bun", "install", "--frozen-lockfile"], dir);
  const site = join(dir, "website");
  await run(["bun", "install", "--frozen-lockfile"], site);
  await run(["bun", "run", "build"], site);
  return builtPages(join(site, "dist"));
}

/** The worktree paths of a `git worktree list --porcelain` listing. */
export function worktreePaths(listing: string): Set<string> {
  return new Set(
    listing
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length)),
  );
}

/**
 * The worktrees still registered after `git worktree remove`: every one,
 * when the registrations cannot be listed.
 */
function removeWorktrees(root: string, made: string[]): string[] {
  const git = (args: string[]) =>
    spawnSync("git", args, { cwd: root, env: ENV, timeout: 60_000 });
  for (const dir of made) git(["worktree", "remove", "--force", dir]);
  const list = git(["worktree", "list", "--porcelain"]);
  if (list.status !== 0) return made;
  const registered = worktreePaths(String(list.stdout ?? ""));
  return made.filter((dir) => registered.has(dir));
}

/** A line cut to a readable width. */
function clip(line: string, width = 160): string {
  return line.length > width ? `${line.slice(0, width - 1)}…` : line;
}

function report(diff: SiteDiff, lines: number): string {
  const out: string[] = [];
  const more = (list: string[]) =>
    list.length > lines ? [`    … ${list.length - lines} more`] : [];
  for (const r of diff.added) out.push(`added    ${r}`);
  for (const r of diff.removed) out.push(`removed  ${r}`);
  for (const c of diff.changed) {
    out.push(`changed  ${c.route}`);
    for (const l of c.removed.slice(0, lines)) out.push(`    - ${clip(l)}`);
    out.push(...more(c.removed));
    for (const l of c.added.slice(0, lines)) out.push(`    + ${clip(l)}`);
    out.push(...more(c.added));
  }
  return out.length ? out.join("\n") : "site-diff: no page's content changed";
}

interface Options {
  base: string;
  head: string;
  lines: number;
  json: boolean;
  keep: boolean;
}

/** The command line, or null when it is not a valid one. */
export function parseArgs(args: string[]): Options | null {
  const at = args.indexOf("--lines");
  const isValue = (i: number) => at !== -1 && i === at + 1;
  const lines = at === -1 ? 6 : Number(args[at + 1]);
  const known = new Set(["--lines", "--json", "--keep"]);
  const options = args.filter((a, i) => a.startsWith("--") && !isValue(i));
  const refs = args.filter((a, i) => !a.startsWith("--") && !isValue(i));
  const [base, head] = refs;
  const valid =
    refs.length === 2 &&
    options.every((o) => known.has(o)) &&
    Number.isInteger(lines) &&
    lines >= 0;
  if (!valid || !base || !head) return null;
  return {
    base,
    head,
    lines,
    json: options.includes("--json"),
    keep: options.includes("--keep"),
  };
}

/** Removes the scratch worktrees; false, with the recovery named, when one stays registered. */
function cleanUp(root: string, scratch: string, made: string[]): boolean {
  const stuck = removeWorktrees(root, made);
  if (!stuck.length) {
    rmSync(scratch, { recursive: true, force: true });
    return true;
  }
  console.error(
    `site-diff: could not remove the worktrees ${stuck.join(", ")}; ${scratch} is left in place. Remove each with \`git worktree remove --force <dir>\`, then run \`git worktree prune\`.`,
  );
  return false;
}

if (import.meta.main)
  cli(async () => {
    const options = parseArgs(process.argv.slice(2));
    if (!options) {
      console.error(
        "usage: site-diff.ts <base-ref> <head-ref> [--lines <n>] [--json] [--keep]",
      );
      return 2;
    }
    const root = (
      await run(["git", "rev-parse", "--show-toplevel"], process.cwd(), {
        output: true,
      })
    ).trim();
    // The resolved path, as git records it, so a registration can be matched.
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "jig-site-diff.")));
    const made: string[] = [];
    let status = 2;
    try {
      const before = await buildAt(root, scratch, "base", options.base, made);
      const after = await buildAt(root, scratch, "head", options.head, made);
      const diff = diffSites(before, after);
      console.log(
        options.json
          ? JSON.stringify(diff, null, 2)
          : report(diff, options.lines),
      );
      status =
        diff.added.length || diff.removed.length || diff.changed.length ? 1 : 0;
    } finally {
      if (options.keep)
        console.error(`site-diff: worktrees kept under ${scratch}`);
      else if (!cleanUp(root, scratch, made)) status = 2;
    }
    return status;
  });
