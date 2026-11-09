/**
 * A live child counts as a pass unless its executable is one of Jig's own
 * top-level helper scripts. Helpers' children are pruned: their git/gh calls
 * are bookkeeping, while the pass is always a direct child of the driver.
 *
 * Linux reads NUL-separated /proc argv to preserve spaces inside paths. On
 * macOS, other platforms, or an unreadable /proc entry, the flattened process
 * display is ambiguous: a checkout name ending in `.ts` followed by a space
 * can resemble a pass with a helper path argument. The fallback counts that
 * ambiguity as a pass, avoiding a false WEDGED verdict.
 *
 * This proves only that a pass-shaped process exists, not that it still does
 * useful work. The doctor combines this signal with lease and progress age.
 */
import { readFileSync } from "node:fs";
import { swallow } from "../../../../shared/errors.ts";
import { processTable } from "../../../../shared/process-table.ts";

/**
 * `true`/`false` are positive answers; `null` is "the probe could not run or
 * could not be parsed" — no `ps` on `PATH`, a non-zero exit, unparsable
 * output, or an unavailable native process provider. `classifyDrive`
 * must never turn `null` into `HEALTHY`; it is `WEDGED`'s own fail-closed
 * requirement (`passChild === false`, never merely falsy) that makes this
 * distinction load-bearing rather than decorative.
 */
export type PassChildAnswer = true | false | null;

/** Only these skill families run as bookkeeping helpers; other skills may be passes. */
const OWN_HELPER_SCRIPT =
  /[\\/]skills[\\/](?:drive-pr|resolve-review-comments|do-item)[\\/]scripts[\\/][^\\/]+\.ts(?=[\s'"]|$)/;

/** Helper interpreters, compared by basename with their complete path preserved. */
const RUNTIME_BASENAME = /(?:^|[\\/])(?:bun|node)(?:\.exe)?$/i;

/** Conservative recognizer for flattened process displays without argv. */
function isOwnHelperInvocation(args: string): boolean {
  const absolute = (path: string) =>
    /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path.replace(/^['"]/, ""));
  const unquote = (path: string) => path.replace(/^['"]|['"]$/g, "");
  const trimmed = args.trimStart();
  const match = OWN_HELPER_SCRIPT.exec(trimmed);
  if (match === null) return false;
  const prefix = trimmed.slice(0, match.index);
  if (prefix.search(/\s/) === -1) return true;

  const isFlagged = (s: string) => /(?:^|\s)-/.test(s);

  const isCompleteScriptPath = (s: string) => /\.ts$/.test(unquote(s));

  const hasFreshPathRestart = (s: string): boolean => {
    for (const ws of s.matchAll(/\s+/g)) {
      const before = s.slice(0, ws.index as number);
      const after = s.slice((ws.index as number) + ws[0].length);
      if (absolute(after) || isCompleteScriptPath(before)) return true;
    }
    return false;
  };

  let freshPathRestart = false;
  for (const ws of prefix.matchAll(/\s+/g)) {
    const before = prefix.slice(0, ws.index as number);
    const after = prefix.slice((ws.index as number) + ws[0].length);
    if (
      RUNTIME_BASENAME.test(unquote(before)) &&
      absolute(after) &&
      !isFlagged(after) &&
      !hasFreshPathRestart(after)
    ) {
      return true;
    }
    if (absolute(after) || isCompleteScriptPath(before)) {
      freshPathRestart = true;
    }
  }

  return !freshPathRestart && absolute(prefix) && !isFlagged(prefix);
}

/** Exported for `pass-child.test.ts` — synthetic fixtures for {@link findPassChild}. */
export interface ProcRow {
  pid: number;
  ppid: number;
  args: string;
  argv?: readonly string[];
}

/**
 * Parse `ps -A -o pid=,ppid=,args=` output. `args` is the LAST field and
 * consumes the remainder of the line (a command line legitimately contains
 * whitespace), so this anchors on the first two whitespace-separated tokens
 * rather than a blind `split(/\s+/)`, unlike `parsePsStatRows` above in
 * `proc.ts` — that parser's third field (`stat`) is a single token with
 * nothing after it, so a naive split is safe there and is not here.
 */
export function parsePassChildRows(output: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of output.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m === null) continue;
    const pid = Number.parseInt(m[1] as string, 10);
    const ppid = Number.parseInt(m[2] as string, 10);
    if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
    rows.push({ pid, ppid, args: m[3] as string });
  }
  return rows;
}

/** Classify a process snapshot without following an excluded helper's children. */
export function findPassChild(pid: number, rows: readonly ProcRow[]): boolean {
  const byPpid = new Map<number, ProcRow[]>();
  for (const row of rows) {
    const children = byPpid.get(row.ppid) ?? [];
    children.push(row);
    byPpid.set(row.ppid, children);
  }

  const stack: ProcRow[] = [...(byPpid.get(pid) ?? [])];
  // Ignore duplicate or corrupt self-referencing process rows.
  const visited = new Set<number>();
  while (stack.length > 0) {
    const cur = stack.pop() as ProcRow;
    if (visited.has(cur.pid)) continue;
    visited.add(cur.pid);
    if (!isHelperProcess(cur)) return true;
    // PRUNED HERE: `cur` is one of this repository's own helper scripts, so
    // its children are never pushed — everything a helper spawns (`gh`,
    // `git`, a further helper) is helper work, never the pass itself.
  }
  return false;
}

/** Preserve argv boundaries when available; otherwise use the conservative display classifier. */
function isHelperProcess(row: ProcRow): boolean {
  if (row.argv === undefined) return isOwnHelperInvocation(row.args);
  const script = row.argv[RUNTIME_BASENAME.test(row.argv[0] ?? "") ? 1 : 0];
  return (
    typeof script === "string" &&
    /[\\/]skills[\\/](?:drive-pr|resolve-review-comments|do-item)[\\/]scripts[\\/][^\\/]+\.ts$/.test(
      script,
    )
  );
}

/**
 * Take one native process snapshot for all drivers and preserve Linux argv.
 * A process can still exit between this observation and a caller's action.
 */
export async function snapshotProcesses(): Promise<ProcRow[] | null> {
  const rows = await processTable();
  if (rows === null) return null;
  return rows.map((row) => {
    const argv = readProcessArgv(row.pid);
    return argv === undefined ? row : { ...row, argv };
  });
}

/**
 * Does driver `pid` currently have a live descendant that is NOT one of this
 * repository's own skill-script invocations? See the module header for the
 * full recognizer rationale, and {@link findPassChild} for the walk itself.
 *
 * The single-pid convenience form: takes its own snapshot. A caller asking
 * about more than one pid should take one {@link snapshotProcesses} and walk
 * it with {@link findPassChild} instead.
 */
export async function hasPassChild(pid: number): Promise<PassChildAnswer> {
  const rows = await snapshotProcesses();
  if (rows === null) return null;
  return findPassChild(pid, rows);
}

/** Read actual argv on Linux; an unavailable or malformed record uses the display fallback. */
export function readProcessArgv(
  pid: number,
  platform: string = process.platform,
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
): string[] | undefined {
  if (platform !== "linux") return undefined;
  try {
    const raw = read(`/proc/${pid}/cmdline`);
    if (!raw.endsWith("\0")) return undefined;
    const argv = raw.slice(0, -1).split("\0");
    return argv[0] ? argv : undefined;
  } catch (err) {
    swallow(err, "Linux process argv unavailable; using process display");
    return undefined;
  }
}
