/**
 * Which of this user's processes have their working directory in a tree, as
 * the machine a runner reaches can tell it: from `/proc` where the host has
 * it, else from `lsof`. An answer is complete or it is no answer: the
 * listing is accepted only when every error it reported names a process
 * that ended while it was read, or one whose working directory the kernel
 * hides from its owner because the process holds privileges its owner lacks
 * (a service manager, say), which no session started in a worktree does.
 * Any other error, a process whose directory cannot be read for another
 * reason included, means a process in the tree could have been missed.
 */
import type { RunResult } from "./orca-workspace/runner.ts";

/** Runs one probe command on the host the tree is on; `cwd` is where it runs. */
export type ProbeRun = (argv: string[], cwd?: string) => RunResult;

/**
 * Lists this user's processes and their working directories:
 * `/proc/<pid>\t<cwd>` lines from `/proc` where the host has it (an empty
 * `<cwd>` when it cannot be read), else `lsof`'s `p<pid>`/`n<cwd>` fields.
 */
const CWD_PROBE = `if [ -e /proc/self/cwd ]; then exec find /proc -mindepth 2 -maxdepth 2 -name cwd -uid "$(id -u)" -printf '%h\\t%l\\n'; else exec lsof -a -d cwd -Fpn; fi`;

export type CwdAnswer = { pids: string[] } | { unknown: string };

/** Whether `cwd` is `top` or under it. */
function inside(cwd: string, top: string): boolean {
  return cwd === top || cwd.startsWith(top.endsWith("/") ? top : `${top}/`);
}

/** The listing's pids working in `top`, and the pids whose directory it could not read. */
export function parseCwdListing(
  listing: string,
  top: string,
): { pids: string[]; unread: string[] } {
  const pids: string[] = [];
  const unread: string[] = [];
  let pid: string | null = null;
  for (const line of listing.split("\n")) {
    const proc = /^\/proc\/(\d+)\t(.*)$/.exec(line);
    if (proc !== null) {
      const [, id, cwd] = proc as unknown as [string, string, string];
      if (cwd === "") unread.push(id);
      else if (inside(cwd, top)) pids.push(id);
      continue;
    }
    if (line.startsWith("p")) pid = line.slice(1);
    else if (line.startsWith("n") && pid !== null && inside(line.slice(1), top))
      pids.push(pid);
  }
  return { pids: [...new Set(pids)], unread };
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
    if (pid !== undefined && /No such file or directory/.test(line)) continue;
    if (pid !== undefined && /Permission denied/.test(line)) {
      denied.push(pid);
      continue;
    }
    return { unknown: line.trim() };
  }
  return { denied };
}

/** Why the process `pid`, whose working directory its owner cannot read, may still be in the tree; `null` when it ended or holds privileges its owner lacks. */
function deniedWhy(run: ProbeRun, pid: string): string | null {
  const status = run(["cat", `/proc/${pid}/status`]);
  if (status.status !== 0)
    return /No such file or directory/.test(status.stderr)
      ? null
      : `process ${pid}'s working directory and status cannot be read`;
  const permitted = /^CapPrm:\s*([0-9a-f]+)$/m.exec(status.stdout)?.[1];
  return permitted !== undefined && /[1-9a-f]/.test(permitted)
    ? null
    : `process ${pid}'s working directory cannot be read`;
}

/** The pids of this user's processes working in `top`, or why that cannot be told. */
export function cwdHolders(run: ProbeRun, top: string): CwdAnswer {
  const listed = run(["sh", "-c", CWD_PROBE], "/");
  // An empty listing is no answer: it always holds the probe's own process.
  if ((listed.status !== 0 && listed.status !== 1) || listed.stdout === "")
    return {
      unknown: `the process listing failed (exit ${listed.status}): ${listed.stderr.trim() || "no output"}`,
    };
  const errors = sortCwdErrors(listed.stderr);
  if ("unknown" in errors) return { unknown: errors.unknown };
  const { pids, unread } = parseCwdListing(listed.stdout, top);
  for (const pid of new Set([...errors.denied, ...unread])) {
    const why = deniedWhy(run, pid);
    if (why !== null) return { unknown: why };
  }
  return { pids };
}
