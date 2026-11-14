/** Runs a stage with bounded output, process cleanup and parent-death supervision. */
import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { swallow } from "../../shared/errors.ts";
import {
  captureIdentity,
  judge,
  thisHost,
  type ProcessIdentity,
} from "../../shared/liveness.ts";
import { processTable } from "../../shared/process-table.ts";
import { currentMs } from "../../shared/time.ts";
import { QuestionTail } from "./question-tail.ts";
import { QUESTION_PREFIX } from "./session.ts";
import { NO_WATCH, watchWindowsTree } from "./windows-tree.ts";
import { registerStageProcess } from "./launch-supervision.ts";

const FORWARDED = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const QUESTION_CHARS = 1000;
/** How long a pass stopped at its deadline has to end before it is killed. */
const STOP_GRACE_MS = 10_000;
/** How long the wrapper waits, once the stage exited, for the rest of its output and for its descendants to end. */
const DRAIN_MS = 2000;
const DEFAULT_OPTIONS: RunOptions = { keepOutput: false, deadlineSec: 0 };

export interface Ran {
  started?: number;
  exited?: number;
  output?: string;
  /** The end of the stage's error output, where the wrapper kept it. */
  errors?: string;
  /** Per-stream reconstruction for startup notices whose chunks interleave. */
  startupOutput?: string;
  code: number | null;
  signal: string | null;
  /** The stage's last `Question:` line, where the wrapper kept it. */
  said?: string;
  /** Observed process cleanup could not be confirmed, so no exit is published. */
  unconfirmed?: true;
  interrupted?: true;
  /** The owned child pid, also kept when a rapid exit prevents identity capture. */
  pid?: number;
}

/** How the wrapper runs a stage: whether it keeps its last question, or only the end of its error output, and the deadline it enforces itself (seconds, `0` for none). */
export interface RunOptions {
  keepOutput: boolean;
  keepErrors?: boolean;
  deadlineSec: number;
  owner?: {
    id: string;
    token: string;
    wrapper: ProcessIdentity;
    supervisor: ProcessIdentity;
  };
}

/** Whether a process group still has a member. */
async function groupAlive(pid: number): Promise<boolean> {
  const rows = await processTable();
  if (rows !== null) {
    const group = rows.find((row) => row.pid === pid)?.pgid ?? pid;
    return rows.some((row) => row.pgid === group && !row.stat.startsWith("Z"));
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Kill what is left of a pass's group and wait, briefly, for it to end. */
async function endGroup(
  pid: number | undefined,
  signalTree: (name: NodeJS.Signals) => void,
): Promise<boolean> {
  if (pid === undefined || !(await groupAlive(pid))) return true;
  signalTree("SIGKILL");
  const gone = currentMs() + DRAIN_MS;
  while ((await groupAlive(pid)) && currentMs() < gone) await Bun.sleep(20);
  return !(await groupAlive(pid));
}

/** The timers that stop a pass at its deadline: a signal, then a kill after the grace. */
function armDeadline(
  deadlineSec: number,
  signalTree: (name: NodeJS.Signals) => void,
  endTree: () => Promise<void>,
): ReturnType<typeof setTimeout>[] {
  const timers: ReturnType<typeof setTimeout>[] = [];
  if (deadlineSec <= 0) return timers;
  timers.push(
    setTimeout(() => {
      console.error(
        `jig dispatch run: the pass ran past its ${deadlineSec}s deadline; stopping it`,
      );
      signalTree("SIGTERM");
      timers.push(
        setTimeout(() => {
          signalTree("SIGKILL");
          void endTree();
        }, STOP_GRACE_MS),
      );
    }, deadlineSec * 1000),
  );
  return timers;
}

/** Wait, briefly, for the last of a pass's output; a pipe a surviving descendant holds open is let go. */
async function drainOutput(
  child: ChildProcess,
  drained: () => boolean,
): Promise<void> {
  const until = currentMs() + DRAIN_MS;
  while (!drained() && currentMs() < until) await Bun.sleep(20);
  if (!drained()) releasePipe(child);
}

/** Let go of a pass's output pipe that a surviving descendant holds open. */
function releasePipe(child: ChildProcess): void {
  child.stdout?.removeAllListeners("data");
  child.stdout?.destroy();
  child.stderr?.removeAllListeners("data");
  child.stderr?.destroy();
}

export function runStage(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  options: RunOptions = DEFAULT_OPTIONS,
): Promise<Ran> {
  return new Promise((settle) => {
    const started = currentMs();
    let output = "";
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    // A pass under a deadline leads its own process group, so the deadline reaches what the agent started too.
    const grouped =
      (options.owner !== undefined || options.deadlineSec > 0) &&
      process.platform !== "win32";
    // Windows has no process group to signal; its tree is walked and ended by identity.
    const treed =
      (options.owner !== undefined || options.deadlineSec > 0) &&
      process.platform === "win32";
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd,
      env,
      detached: grouped,
      stdio: options.keepOutput
        ? ["inherit", "pipe", "pipe"]
        : options.keepErrors === true
          ? ["inherit", "inherit", "pipe"]
          : "inherit",
    });
    const watch = treed
      ? watchWindowsTree(
          child.pid,
          () => child.exitCode === null && child.signalCode === null,
        )
      : NO_WATCH;
    let treeEnded = true;
    const endWindowsTree = async () => {
      treeEnded = (await watch.end()) && treeEnded;
    };
    const signalTree = (name: NodeJS.Signals) => {
      if (grouped && child.pid !== undefined) {
        try {
          process.kill(-child.pid, name);
          return;
        } catch (error) {
          swallow(error, "the pass's group is gone or unsignalable");
        }
      }
      child.kill(name);
    };
    const tail = new QuestionTail(QUESTION_PREFIX, QUESTION_CHARS);
    let drained = !options.keepOutput;
    child.stdout?.on("data", (chunk: Buffer) => {
      const decoded = stdoutDecoder.write(chunk);
      stdout = (stdout + decoded).slice(-8192);
      output = (output + decoded).slice(-8192);
      if (!process.stdout.write(chunk)) {
        child.stdout?.pause();
        process.stdout.once("drain", () => child.stdout?.resume());
      }
      tail.write(chunk);
    });
    child.stdout?.on("end", () => {
      const decoded = stdoutDecoder.end();
      stdout = (stdout + decoded).slice(-8192);
      output = (output + decoded).slice(-8192);
      drained = true;
    });
    let stderrDrained = child.stderr === null;
    child.stderr?.on("data", (chunk: Buffer) => {
      const decoded = stderrDecoder.write(chunk);
      stderr = (stderr + decoded).slice(-8192);
      output = (output + decoded).slice(-8192);
      if (!process.stderr.write(chunk)) {
        child.stderr?.pause();
        process.stderr.once("drain", () => child.stderr?.resume());
      }
    });
    child.stderr?.on("end", () => {
      const decoded = stderrDecoder.end();
      stderr = (stderr + decoded).slice(-8192);
      output = (output + decoded).slice(-8192);
      stderrDrained = true;
    });
    let stopping = false;
    const stop = (name: NodeJS.Signals) => {
      if (ended || stopping) return;
      stopping = true;
      signalTree(name);
      timers.push(setTimeout(() => signalTree("SIGKILL"), STOP_GRACE_MS));
    };
    const forward = (name: NodeJS.Signals) => stop(name);
    for (const name of FORWARDED) process.on(name, forward);
    const timers = armDeadline(options.deadlineSec, stop, () =>
      endWindowsTree(),
    );
    const parentWatch = watchOwner(options.owner, () => ended, stop);
    registerChild(child, options.owner, () => ended, stop);
    let ended = false;
    const done = async (code: number | null, signal: string | null) => {
      if (ended) return;
      ended = true;
      if (parentWatch !== null) clearInterval(parentWatch);
      const exited = currentMs();
      for (const timer of timers) clearTimeout(timer);
      watch.stopSampling();
      // What the agent started can outlive it; the exit is published once the group has ended.
      if (grouped) treeEnded = await endGroup(child.pid, signalTree);
      await endWindowsTree();
      for (const name of FORWARDED) process.off(name, forward);
      await drainOutput(child, () => drained && stderrDrained);
      tail.end();
      settle({
        code,
        signal,
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        started,
        exited,
        output,
        startupOutput: `${stdout}\n${stderr}`,
        ...(child.stderr === null ? {} : { errors: stderr }),
        ...(!treeEnded ? { unconfirmed: true as const } : {}),
        ...(stopping ? { interrupted: true as const } : {}),
        ...(options.keepOutput && tail.question !== ""
          ? { said: tail.question }
          : {}),
      });
    };
    child.on("error", (error) => {
      console.error(`jig dispatch run: ${error.message}`);
      void done(127, null);
    });
    child.on("exit", (code, signal) => void done(code, signal));
  });
}

/** Parent death is sampled separately from the stage's deadline. */
function watchOwner(
  owner: RunOptions["owner"],
  ended: () => boolean,
  stop: (signal: NodeJS.Signals) => void,
): ReturnType<typeof setInterval> | null {
  if (owner === undefined) return null;
  let checking = false;
  return setInterval(() => {
    if (checking || ended()) return;
    checking = true;
    void processTable()
      .then((rows) => {
        const verdict = judge(owner.wrapper, rows, thisHost());
        if (verdict.ok && verdict.value.state === "dead" && !ended())
          stop("SIGTERM");
      })
      .finally(() => {
        checking = false;
      });
  }, 1000);
}

/** The asynchronous identity read is bound only while the child handle owns the pid. */
function registerChild(
  child: ChildProcess,
  owner: RunOptions["owner"],
  ended: () => boolean,
  stop: (signal: NodeJS.Signals) => void,
): void {
  if (owner === undefined || child.pid === undefined) return;
  void captureIdentity(child.pid).then((identity) => {
    if (ended() || child.exitCode !== null || child.signalCode !== null) return;
    const registered = identity.ok
      ? registerStageProcess(
          owner.id,
          owner.token,
          "child",
          identity.value,
          owner.supervisor,
        )
      : identity;
    if (!registered.ok) {
      swallow(registered.failure.cause, registered.failure.reason);
      console.error(
        `jig dispatch run: ${registered.failure.reason}; stopping the stage`,
      );
      stop("SIGTERM");
    }
  });
}
