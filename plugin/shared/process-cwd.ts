/**
 * Which of this user's processes have their working directory in a tree, as
 * the machine a runner reaches can tell it: from `/proc` where the host has
 * it, else from `lsof`. An answer is complete or it is no answer: the
 * listing is accepted only when every error it reported names a process
 * that ended while it was read, or one whose working directory the kernel
 * hides from its owner because the process holds privileges its owner lacks
 * (a service manager, say) or runs in a nested PID namespace (a container
 * whose runtime started it as root and dropped to the owner's uid), which
 * no session started in a worktree does. Any other error, a process of the
 * probe's own PID namespace whose directory cannot be read for another
 * reason included, means a process in the tree could have been missed.
 *
 * The nested-namespace boundary: `NStgid:` lists a process's pid in each
 * PID namespace from the probe's own down to the process's, so more than
 * one pid means a namespace nested under the probe's, provided `/proc`
 * is the probe's own namespace's (checked before any such process is
 * accepted: the probe's own `NStgid:` holds one pid). A container's
 * processes also live in a mount namespace of their own, outside what the
 * probe can inspect, and no session a host starts runs only there: a
 * sandbox an agent starts itself (an unprivileged user namespace, as
 * bubblewrap makes) stays readable by its owner and is listed like any
 * other process, and the agent that started it runs in the probe's
 * namespace with its own working directory. The rule does not see a
 * detached container that bind-mounts a tree at the same path and works in
 * it with its directory hidden: the probe accepts that process and reports
 * no holder for it. A container sharing the probe's PID namespace
 * (`--pid=host`) shows one pid and is still no answer.
 */
import type { RunResult } from "./orca-workspace/runner.ts";
import { currentMs } from "./time.ts";

/** Runs one probe command on the host the tree is on; `cwd` is where it runs. */
export type ProbeRun = (argv: string[], cwd?: string) => RunResult;

/**
 * Lists this user's processes and their working directories:
 * `/proc/<pid>\t<cwd>` lines from `/proc` where the host has it (an empty
 * `<cwd>` when it cannot be read), else `lsof`'s `p<pid>`/`n<cwd>` fields.
 */
const CWD_PROBE = `if [ -e /proc/self/cwd ]; then exec find /proc -mindepth 2 -maxdepth 2 -name cwd -uid "$(id -u)" -printf '%h\\t%l\\n'; else exec lsof -a -d cwd -Fpn; fi`;

export type CwdAnswer = { pids: string[] } | { unknown: string };

/** `ProbeRun` that does not block the caller while the probe runs. */
export type AsyncProbeRun = (
  argv: string[],
  cwd?: string,
  /** The seconds this one read may take; the probe's own bound when absent. */
  timeoutSec?: number,
) => Promise<RunResult>;

/** What stops a scan: a signal that ends it and the one deadline all its reads share. */
export type ScanBounds = {
  signal?: AbortSignal | undefined;
  /** The whole scan's allowance in milliseconds, shared by the listing and every status read. */
  deadlineMs?: number | undefined;
};

/** Whether `cwd` is `top` or under it. */
function inside(cwd: string, top: string): boolean {
  return cwd === top || cwd.startsWith(top.endsWith("/") ? top : `${top}/`);
}

const LSOF_C_ESCAPES: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
};

/**
 * lsof's name field with its escapes undone, read as UTF-8: `\xHH` bytes,
 * the C forms (`\t`, `\n`, `\\` and the like) and, when `caret`, `^X`
 * control notation. A `^` may also be a literal character of the name, so
 * the caller tries both readings.
 */
function unescapeLsof(name: string, caret: boolean): string {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let i = 0; i < name.length; ) {
    const hex = /^\\x([0-9a-fA-F]{2})/.exec(name.slice(i, i + 4));
    const c = name[i + 1];
    const control = caret && name[i] === "^" ? name.charCodeAt(i + 1) : NaN;
    if (hex !== null) {
      bytes.push(Number.parseInt(hex[1] as string, 16));
      i += 4;
    } else if (name[i] === "\\" && c !== undefined && c in LSOF_C_ESCAPES) {
      bytes.push(LSOF_C_ESCAPES[c] as number);
      i += 2;
    } else if (control >= 0x40 && control <= 0x5f) {
      bytes.push(control - 0x40);
      i += 2;
    } else if (control === 0x3f) {
      bytes.push(0x7f);
      i += 2;
    } else {
      const point = name.codePointAt(i) as number;
      const char = String.fromCodePoint(point);
      bytes.push(...encoder.encode(char));
      i += char.length;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Whether lsof gave only part of a name: it prints a filesystem name, ` -- `
 * and the components it could recover, which no path comparison can place.
 */
function incompleteLsof(name: string): boolean {
  return name.includes(" -- ");
}

/**
 * One process's working directory as a listing gave it: the names it may be
 * read as (`/proc` gives one, lsof's escaped field up to three), `unread`
 * when the kernel gave none, and `partial` for a name lsof gave only in part.
 */
interface CwdEntry {
  pid: string;
  names: string[];
  unread: boolean;
  partial: boolean;
}

/** The listing's entries, each name read once however many trees it is later asked about. */
function parseEntries(listing: string): CwdEntry[] {
  const entries: CwdEntry[] = [];
  let pid: string | null = null;
  for (const line of listing.split("\n")) {
    const proc = /^\/proc\/(\d+)\t(.*)$/.exec(line);
    if (proc !== null) {
      const [, id, cwd] = proc as unknown as [string, string, string];
      entries.push({
        pid: id,
        names: cwd === "" ? [] : [cwd],
        unread: cwd === "",
        partial: false,
      });
      continue;
    }
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid !== null) {
      const name = line.slice(1);
      entries.push({
        pid,
        names: [name, unescapeLsof(name, false), unescapeLsof(name, true)],
        unread: false,
        partial: incompleteLsof(name),
      });
    }
  }
  return entries;
}

/** The entries' pids working in `top`, the pids whose directory it could not read and the names lsof gave only in part. */
function readEntries(
  entries: CwdEntry[],
  top: string,
): { pids: string[]; unread: string[]; partial: string[] } {
  const pids: string[] = [];
  const unread: string[] = [];
  const partial: string[] = [];
  for (const entry of entries) {
    if (entry.unread) unread.push(entry.pid);
    else if (entry.names.some((name) => inside(name, top)))
      pids.push(entry.pid);
    else if (entry.partial) partial.push(entry.names[0] as string);
  }
  return { pids: [...new Set(pids)], unread, partial };
}

/** The listing's pids working in `top`, the pids whose directory it could not read and the names lsof gave only in part. */
export function parseCwdListing(
  listing: string,
  top: string,
): { pids: string[]; unread: string[]; partial: string[] } {
  return readEntries(parseEntries(listing), top);
}

/**
 * Sort the probe's error lines: a process that vanished is nothing, one
 * denied is a pid to look at, anything else is the line that makes the
 * listing incomplete.
 */
function sortCwdErrors(
  stderr: string,
): { denied: string[] } | { unknown: string } {
  const denied: string[] = [];
  for (const line of stderr.split("\n")) {
    if (line.trim() === "") continue;
    const pid = /\/proc\/(\d+)/.exec(line)?.[1];
    if (pid !== undefined && /No such (?:file or directory|process)/.test(line))
      continue;
    if (pid !== undefined && /Permission denied/.test(line)) {
      denied.push(pid);
      continue;
    }
    return { unknown: line.trim() };
  }
  return { denied };
}

/**
 * Why the process whose `/proc/<pid>/status` read gave `status` may still be
 * in the tree; `null` when it ended, holds permitted capabilities its owner
 * lacks (a non-zero `CapPrm`), or runs in a nested PID namespace (more than
 * one pid on `NStgid:`, a container's). A process of the probe's own PID
 * namespace (one pid on `NStgid:`, or no such line) with no permitted
 * capabilities is the reason.
 */
function deniedReason(pid: string, status: RunResult): string | null {
  if (status.status !== 0)
    return /No such (?:file or directory|process)/.test(status.stderr)
      ? null
      : `process ${pid}'s working directory and status cannot be read`;
  const permitted = /^CapPrm:\s*([0-9a-f]+)$/m.exec(status.stdout)?.[1];
  if (permitted !== undefined && /[1-9a-f]/.test(permitted)) return null;
  const nested = /^NStgid:[ \t]*\d+(?:[ \t]+\d+)+[ \t]*$/m.test(status.stdout);
  return nested ? null : `process ${pid}'s working directory cannot be read`;
}

/**
 * Whether `/proc` is the probe's own PID namespace's: the probe's own
 * `/proc/self/status` names one pid on `NStgid:`. With more, procfs belongs
 * to an ancestor namespace and a process's pid count says nothing about
 * where it runs relative to the probe.
 */
function ownProcfs(own: RunResult): boolean {
  return own.status === 0 && /^NStgid:[ \t]*\d+[ \t]*$/m.test(own.stdout);
}

/** The probe's listing, or why it is no answer, with the pids its errors say it could not read. */
function readProbe(
  listed: RunResult,
): { unknown: string } | { listing: string; denied: string[] } {
  // An empty listing is no answer: it always holds the probe's own process.
  if ((listed.status !== 0 && listed.status !== 1) || listed.stdout === "")
    return {
      unknown: `the process listing failed (exit ${listed.status}): ${listed.stderr.trim() || "no output"}`,
    };
  const errors = sortCwdErrors(listed.stderr);
  if ("unknown" in errors) return { unknown: errors.unknown };
  return { listing: listed.stdout, denied: errors.denied };
}

const partialAnswer = (name: string): CwdAnswer => ({
  unknown: `lsof gave only part of a working directory's name (${name})`,
});

/** The pids of this user's processes working in `top`, or why that cannot be told. */
export function cwdHolders(run: ProbeRun, top: string): CwdAnswer {
  const probed = readProbe(run(["sh", "-c", CWD_PROBE], "/"));
  if ("unknown" in probed) return probed;
  const { pids, unread, partial } = parseCwdListing(probed.listing, top);
  if (partial.length > 0) return partialAnswer(partial[0] as string);
  const unreadable = new Set([...probed.denied, ...unread]);
  if (unreadable.size > 0 && !ownProcfs(run(["cat", "/proc/self/status"])))
    return {
      unknown: "the /proc mounted here is not the probe's own PID namespace's",
    };
  for (const pid of unreadable) {
    const why = deniedReason(pid, run(["cat", `/proc/${pid}/status`]));
    if (why !== null) return { unknown: why };
  }
  return { pids };
}

/**
 * Prints each pid among its arguments, after the first two, whose environment
 * holds the first argument as a whole entry, whose controlling terminal
 * (field 7 of `/proc/<pid>/stat`) is none and which started no later than the
 * second argument (seconds since the epoch, from its start time in field 22
 * and the boot time in `/proc/stat`); prints nothing on a host without
 * `/proc`. Run as `sh -c <probe> sh <entry> <latest-start> <pid>...`.
 */
const DETACHED_CARRIER_PROBE = `[ -e /proc/self/environ ] || exit 0
entry=$1
latest=$2
shift 2
hz=$(getconf CLK_TCK 2>/dev/null || echo 100)
boot=$(awk '$1 == "btime" { print $2 }' /proc/stat 2>/dev/null)
[ -n "$boot" ] || exit 0
for p do
  tr '\\0' '\\n' < "/proc/$p/environ" 2>/dev/null | grep -qxF -e "$entry" || continue
  fields=$(awk '{ s = $0; sub(/.*\\) /, "", s); split(s, f, " "); print f[5], f[20] }' "/proc/$p/stat" 2>/dev/null)
  tty=\${fields%% *}
  started=\${fields##* }
  [ "$tty" = 0 ] || continue
  [ -n "$started" ] || continue
  [ $((boot + started / hz)) -le "$latest" ] && printf '%s\\n' "$p"
done
exit 0`;

/**
 * The pids among `pids` that were started with the environment entry
 * `entry` (`NAME=value`), have no controlling terminal and started no later
 * than `latestStartSec` (seconds since the epoch), read from `/proc` in one
 * probe: a daemon keeps the environment it started with when it leaves its
 * process group or session, while a shell a person types into has a
 * terminal. The start bound keeps work a person started later, which
 * inherited the entry from such a daemon, out of the answer. A process whose
 * environment or status cannot be read (a host without `/proc`, a process
 * that ended or one its owner may not inspect) is not among them, and
 * neither is any when the probe fails.
 */
export async function detachedCarriers(
  run: AsyncProbeRun,
  pids: string[],
  entry: string,
  latestStartSec: number,
): Promise<Set<string>> {
  const numeric = pids.filter((pid) => /^\d+$/.test(pid));
  if (numeric.length === 0) return new Set();
  const read = await run(
    [
      "sh",
      "-c",
      DETACHED_CARRIER_PROBE,
      "sh",
      entry,
      String(Math.floor(latestStartSec)),
      ...numeric,
    ],
    "/",
  );
  if (read.status !== 0) return new Set();
  return new Set(
    read.stdout.split("\n").filter((pid) => numeric.includes(pid)),
  );
}

/**
 * One scan of this user's processes' working directories, read once and
 * asked about any number of trees with `holdersIn`: the parsed listing and
 * the first reason a process whose directory could not be read may still be
 * in a tree, or why the scan is no answer.
 */
export type CwdScan =
  | { entries: CwdEntry[]; blocked: string | null }
  | { unknown: string };

/** Why an unreadable process blocks the scan, if it does: the probe's own `/proc` first, then each process's status once. */
async function judgeUnreadable(
  unreadable: Set<string>,
  read: (argv: string[], cwd: string | undefined) => Promise<RunResult | null>,
  stopped: () => string | null,
): Promise<{ blocked: string | null } | { unknown: string }> {
  const gone = "the process scan was stopped";
  if (unreadable.size === 0) return { blocked: null };
  let why = stopped();
  if (why !== null) return { unknown: why };
  const own = await read(["cat", "/proc/self/status"], undefined);
  if (own === null) return { unknown: gone };
  if (!ownProcfs(own))
    return {
      blocked: "the /proc mounted here is not the probe's own PID namespace's",
    };
  for (const pid of unreadable) {
    why = stopped();
    if (why !== null) return { unknown: why };
    const status = await read(["cat", `/proc/${pid}/status`], undefined);
    if (status === null) return { unknown: gone };
    const blocked = deniedReason(pid, status);
    if (blocked !== null) return { blocked };
  }
  return { blocked: null };
}

/** Scan once, without blocking the caller; every error is judged as `cwdHolders` judges it, each denied process's status read once, all reads within one deadline and none started after `bounds.signal` fires. */
export async function scanCwds(
  run: AsyncProbeRun,
  bounds: ScanBounds = {},
): Promise<CwdScan> {
  const { signal, deadlineMs } = bounds;
  const end = deadlineMs === undefined ? null : currentMs() + deadlineMs;
  const stopped = (): string | null => {
    if (signal?.aborted) return "the process scan was stopped";
    return end !== null && currentMs() >= end
      ? "the process scan ran past its deadline"
      : null;
  };
  /** The seconds left for the next read, rounded up so a read is never given none. */
  const left = (): number | undefined =>
    end === null
      ? undefined
      : Math.max(1, Math.ceil((end - currentMs()) / 1000));
  /** One read, given up on the moment `signal` fires: the caller stops waiting for it. */
  const read = async (
    argv: string[],
    cwd: string | undefined,
  ): Promise<RunResult | null> => {
    const reading = run(argv, cwd, left());
    if (signal === undefined) return reading;
    let onAbort: () => void = () => undefined;
    const aborted = new Promise<null>((done) => {
      onAbort = () => done(null);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([reading, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };
  const first = stopped();
  if (first !== null) return { unknown: first };
  const listing = await read(["sh", "-c", CWD_PROBE], "/");
  if (listing === null) return { unknown: "the process scan was stopped" };
  const probed = readProbe(listing);
  if ("unknown" in probed) return probed;
  const entries = parseEntries(probed.listing);
  const unread = entries.filter((e) => e.unread).map((e) => e.pid);
  const judged = await judgeUnreadable(
    new Set([...probed.denied, ...unread]),
    read,
    stopped,
  );
  if ("unknown" in judged) return judged;
  const { blocked } = judged;
  // A read that finished past the allowance is no answer inside it.
  const last = stopped();
  if (last !== null) return { unknown: last };
  return { entries, blocked };
}

/** What `cwdHolders` answers for `top`, from a scan made once. */
export function holdersIn(scan: CwdScan, top: string): CwdAnswer {
  if ("unknown" in scan) return scan;
  const { pids, partial } = readEntries(scan.entries, top);
  if (partial.length > 0) return partialAnswer(partial[0] as string);
  if (scan.blocked !== null) return { unknown: scan.blocked };
  return { pids };
}
