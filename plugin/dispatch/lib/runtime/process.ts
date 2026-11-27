/** A local session runtime whose runs are witnessed by process identity. */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  detachedCarriers,
  holdersIn,
  scanCwds,
  type AsyncProbeRun,
  type CwdScan,
} from "../../../shared/process-cwd.ts";
import {
  HOOK_TIMEOUT_MS,
  HOOK_WORKTREE_ENV,
  realPath,
} from "../../../shared/worktree-hooks.ts";
import {
  judge,
  thisHost,
  type ProcessIdentity,
} from "../../../shared/liveness.ts";
import {
  processTable,
  type ProcessRow,
} from "../../../shared/process-table.ts";
import { CREATE_HOOK_MARK } from "../../../shared/orca-workspace/hooks.ts";
import { parseGitWorktreeList } from "../../../shared/orca-workspace/git.ts";
import { run } from "../../../shared/proc.ts";
import { readLaunches, type ReadRecord } from "../launches.ts";
import { failureText } from "../text.ts";
import { verifyPullRequestWorkspace } from "./orca-pr-workspace.ts";
import { orcaEndRun } from "./orca-end-run.ts";
import { orcaCommandOrInstalled } from "../../../shared/orca.ts";
import { marksIn, type AgentSession, type SessionRuntime } from "./port.ts";
import { retireProcessJob } from "./process-service.ts";
import { branchTargets } from "./branch-targets.ts";
import { launchProcess } from "./process-launch.ts";
import { processOpen } from "./process-workspaces.ts";
import type { ProcessSettings } from "./process-environment.ts";
import { attempt } from "../../../shared/outcome.ts";
import { parseMs } from "../../../shared/time.ts";

const SOURCE = "git worktree list and dispatcher launch records";
const BINDING = {
  ok: false as const,
  reason: "the process runtime runs headless sessions only",
};

/** A run's recorded processes: the wrapper's claim, its supervisor and its stage child. */
export function identities(read: Pick<ReadRecord, "state">): ProcessIdentity[] {
  if (!("process" in read.state) || read.state.process === null) return [];
  const claim = read.state.process;
  return [
    claim,
    claim.supervision?.supervisor,
    claim.supervision?.child,
  ].filter((member): member is ProcessIdentity => member != null);
}

/** A run's recorded processes as `rows` judge them: the live pids, and whether any could not be judged. */
export function membersOf(
  read: Pick<ReadRecord, "state">,
  rows: ProcessRow[] | null,
) {
  const here = thisHost();
  const judged = identities(read).map((identity) => ({
    identity,
    live: judge(identity, rows, here),
  }));
  return {
    uncertain: judged.some(({ live }) => !live.ok),
    alive: judged
      .filter(({ live }) => live.ok && live.value.state === "alive")
      .map(({ identity }) => identity.pid),
  };
}

/** `roots` and every process descended from them in `rows`. */
export function descendants(
  rows: ProcessRow[],
  roots: Set<number>,
): Set<number> {
  const known = new Set(roots);
  let changed: boolean;
  do {
    changed = false;
    for (const { pid, ppid } of rows) {
      if (known.has(pid) || !known.has(ppid)) continue;
      known.add(pid);
      changed = true;
    }
  } while (changed);
  return known;
}

function activity(records: ReadRecord[], rows: ProcessRow[] | null) {
  const agents: AgentSession[] = [];
  const known = new Set<number>();
  let uncertain = false;
  for (const read of records) {
    const { alive, uncertain: unreadable } = membersOf(read, rows);
    uncertain ||= unreadable || read.state.kind === "unknown";
    if (alive.length === 0) continue;
    for (const pid of alive) known.add(pid);
    agents.push({
      id: read.record.id,
      agentType: read.record.vendor,
      state: "working",
      since: parseMs(read.record.createdAt),
    });
  }
  return { agents, known: descendants(rows ?? [], known), uncertain };
}

/** The worktree's git directory, read from its `.git` file or directory. */
function gitDirectory(tree: string): string | null {
  const dot = join(tree, ".git");
  try {
    if (statSync(dot).isDirectory()) return dot;
    const line = readFileSync(dot, "utf8").trim();
    if (!line.startsWith("gitdir:")) return null;
    const dir = line.slice("gitdir:".length).trim();
    return isAbsolute(dir) ? dir : resolve(tree, dir);
  } catch {
    return null;
  }
}

/**
 * The latest moment, in seconds since the epoch, a process the tree's create
 * hook started can have started. Once the hook has run, its mark's time ends
 * the window exactly: nothing the hook started began after it finished.
 * Until then the worktree's creation plus the hook's time limit bounds it.
 * Work started after it inherited the marker from something else.
 */
function preparationEndsAt(tree: string): number {
  const dir = gitDirectory(tree);
  if (dir !== null) {
    try {
      return statSync(join(dir, CREATE_HOOK_MARK)).mtimeMs / 1000 + 2;
    } catch {
      // The hook has not left its mark: fall back to its time limit.
    }
  }
  const born = attempt(
    "tree-unreadable",
    "the worktree's creation time",
    () => statSync(join(tree, ".git")).mtimeMs,
  );
  return born.ok ? born.value / 1000 + HOOK_TIMEOUT_MS / 1000 + 15 : 0;
}

/**
 * How many of the processes working in `tree` the runtime cannot account
 * for: every one but a run's recorded processes and their descendants
 * (`known`), and those a worktree hook run for this tree left behind: a
 * process with no controlling terminal whose environment names the tree
 * under `HOOK_WORKTREE_ENV`, the dispatcher's own preparation of it. A
 * process with a terminal, or one that did not keep the environment it
 * started with, still counts. A listing that does not read counts as one.
 */
async function unaccounted(
  run: AsyncProbeRun,
  scan: CwdScan,
  tree: string,
  known: Set<number>,
): Promise<number> {
  const holders = holdersIn(scan, tree);
  if ("unknown" in holders) return 1;
  const unknown = holders.pids.filter((pid) => !known.has(Number(pid)));
  const prepared = await detachedCarriers(
    run,
    unknown,
    `${HOOK_WORKTREE_ENV}=${realPath(tree)}`,
    preparationEndsAt(tree),
  );
  return unknown.filter((pid) => !prepared.has(pid)).length;
}

/**
 * The probe the cwd scan runs on this host, without blocking the event loop
 * every repository's observe shares. Messages stay untranslated: the scan
 * reads some of them as text.
 */
export function localProbe(timeoutSec: number): AsyncProbeRun {
  return async (argv, cwd, limitSec) => {
    const result = await run(argv, {
      timeoutSec: Math.min(timeoutSec, limitSec ?? timeoutSec),
      env: { ...process.env, LC_ALL: "C", LANGUAGE: "" },
      ...(cwd === undefined ? {} : { cwd }),
    });
    // A probe a signal ended part way through printed a part of the listing.
    const killed =
      result.spawnFailed ||
      result.timedOut ||
      result.bufferExceeded ||
      result.signal !== undefined;
    return {
      status: killed ? -1 : result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
}

/** `probe` is the process scan, replaceable where a test counts it. */
export function processRuntime(
  machine: {
    process?: ProcessSettings;
    runtimeTimeoutMs: number;
    workspaceTimeoutMs: number;
  },
  probe: AsyncProbeRun = localProbe(
    Math.max(1, Math.ceil(machine.runtimeTimeoutMs / 1000)),
  ),
): SessionRuntime {
  const timeoutSec = Math.max(1, Math.ceil(machine.runtimeTimeoutMs / 1000));
  return {
    name: "process",
    interactiveBinding: BINDING,
    async sessions(repo, join, signal) {
      const no = (reason: string) => ({
        ok: false as const,
        source: SOURCE,
        reason,
      });
      if (signal?.aborted) return no("the session listing was stopped");
      try {
        const listed = await run(
          ["git", "-C", repo.path, "worktree", "list", "--porcelain", "-z"],
          { timeoutSec },
        );
        if (listed.code !== 0) return no("git could not list the worktrees");
        if (signal?.aborted) return no("the session listing was stopped");
        const worktrees = parseGitWorktreeList(listed.stdout);
        if (worktrees.length === 0)
          return no("git listed no worktrees for the clone");
        const [launches, rows] = await Promise.all([
          readLaunches(),
          processTable(),
        ]);
        if (launches.unreadable.length > 0)
          return no(`a launch record does not read: ${launches.unreadable[0]}`);
        const records = launches.records.filter(
          ({ record }) =>
            record.runtime === "process" && record.repo === repo.slug,
        );
        // One scan answers every worktree: a scan per worktree would block
        // the event loop for as many spawns as the host has worktrees.
        const scan = await scanCwds(probe, {
          signal,
          deadlineMs: machine.runtimeTimeoutMs,
        });
        const workspaces = [];
        for (const tree of worktrees) {
          if (signal?.aborted) return no("the session listing was stopped");
          const inTree = records.filter(
            ({ record }) =>
              record.workspace !== null &&
              resolve(record.workspace.path) === resolve(tree.path),
          );
          const act = activity(inTree, rows);
          const unknown = await unaccounted(probe, scan, tree.path, act.known);
          const branch = tree.branch ?? "";
          const comment = inTree
            .map(({ record }) => record.mark ?? "")
            .filter(Boolean)
            .join("\n");
          workspaces.push({
            id: tree.path,
            path: tree.path,
            branch,
            ...branchTargets(branch, join),
            agents: act.agents,
            unverifiableTerminals: unknown + (act.uncertain ? 1 : 0),
            comment,
            unread: null,
            name: marksIn(comment).at(-1)?.name ?? branch,
          });
        }
        return { ok: true, source: SOURCE, workspaces };
      } catch (error) {
        return no(failureText(error));
      }
    },
    openWorkspace: (repo, target) =>
      processOpen(repo, target, machine.workspaceTimeoutMs),
    verifyWorkspace: (repo, ws, target, timeoutMs) =>
      verifyPullRequestWorkspace(
        repo.path,
        ws.path,
        target.pr,
        target.head,
        Math.min(
          machine.workspaceTimeoutMs,
          timeoutMs ?? machine.workspaceTimeoutMs,
        ),
        repo.slug,
      ),
    launch: (ws, stage, account, token) =>
      launchProcess(
        ws,
        stage,
        account,
        token,
        machine.process ?? { envKeep: [] },
        machine.runtimeTimeoutMs,
      ),
    async notify() {
      return {
        ok: false,
        refused: true,
        detail: "the dashboard lists the cause on the process runtime",
      };
    },
    async steer() {
      return { ok: false, refused: true, detail: BINDING.reason };
    },
    async retire() {
      return { ok: true, nothingLeft: true, detail: "no notices workspace" };
    },
    async endRun(run, timeoutMs, signal) {
      if (run.runtime !== "process")
        return orcaEndRun(
          run,
          orcaCommandOrInstalled(process.env),
          timeoutMs ?? machine.runtimeTimeoutMs,
          undefined,
          signal,
        );
      if (signal?.aborted)
        return { ok: false, detail: "the process lookup was stopped" };
      const [launches, rows] = await Promise.all([
        readLaunches(),
        processTable(),
      ]);
      const read = launches.records.find(({ record }) => record.id === run.id);
      if (read === undefined)
        return { ok: false, detail: "the run's process record did not read" };
      const live = membersOf(read, rows);
      if (live.alive.length > 0)
        return {
          ok: false,
          outlived: true,
          detail: `run outlived its exit with live processes: ${live.alive.join(", ")}`,
        };
      if (live.uncertain)
        return {
          ok: false,
          detail: "the run's process identities could not be verified",
        };
      if (signal?.aborted)
        return { ok: false, detail: "the process lookup was stopped" };
      const cleanup = await retireProcessJob(
        run.id,
        Math.max(1, Math.ceil((timeoutMs ?? machine.runtimeTimeoutMs) / 1000)),
      );
      return cleanup === null
        ? {
            ok: true,
            nothingLeft: true,
            detail: "no recorded run process is alive",
          }
        : { ok: false, detail: cleanup };
    },
  };
}
