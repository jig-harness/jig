/** A local session runtime whose runs are witnessed by process identity. */
import { resolve } from "node:path";
import {
  holdersIn,
  scanCwds,
  type AsyncProbeRun,
} from "../../../shared/process-cwd.ts";
import {
  judge,
  thisHost,
  type ProcessIdentity,
} from "../../../shared/liveness.ts";
import {
  processTable,
  type ProcessRow,
} from "../../../shared/process-table.ts";
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

/**
 * The probe the cwd scan runs on this host, without blocking the event loop
 * every repository's observe shares. Messages stay untranslated: the scan
 * reads some of them as text.
 */
export function localProbe(timeoutSec: number): AsyncProbeRun {
  return async (argv, cwd) => {
    const result = await run(argv, {
      timeoutSec,
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
        const scan = await scanCwds(probe);
        const workspaces = [];
        for (const tree of worktrees) {
          if (signal?.aborted) return no("the session listing was stopped");
          const inTree = records.filter(
            ({ record }) =>
              record.workspace !== null &&
              resolve(record.workspace.path) === resolve(tree.path),
          );
          const act = activity(inTree, rows);
          const holders = holdersIn(scan, tree.path);
          const unknown =
            "unknown" in holders
              ? 1
              : holders.pids.filter((pid) => !act.known.has(Number(pid)))
                  .length;
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
