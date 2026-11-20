/** Opt-in local timing spans. Call sites supply metadata, never command payloads. */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { errnoCode, swallow } from "./errors.ts";
import { GITHUB, type GhRun, ghRunFailure } from "./outbound/github.ts";
import { guarded } from "./outbound/hold.ts";
import { noteForgeAnswer } from "./outbound/forge-limit-seen.ts";
import { recordGhAttempt } from "./outbound/gh-ledger.ts";
import { admitPaced, endedFailure } from "./outbound/forge-pacing.ts";
import {
  type GhAttribution,
  forgeBudgetOn,
  forgeGovernorPacingOn,
  forgeOwner,
  ghHostIn,
  ghGovernance,
} from "./outbound/github-budget.ts";
import { setDiscoveryRunner } from "./outbound/github-owner.ts";
import { drivePages, pagePlan } from "./outbound/gh-paginate.ts";
import { ghRunScope } from "./outbound/github-scope.ts";
import { type OutboundFailure, outboundFailure } from "./outbound/failure.ts";
import { currentIso, currentMs, isoFromMs, parseMs } from "./time.ts";

/** Stable child-process diagnostic code for incomplete forge accounting. */
export const FORGE_ACCOUNTING_UNAVAILABLE = "jig-forge-accounting-unavailable";

type Attributes = Record<string, string | number | boolean | null | undefined>;
interface Context {
  traceId: string;
  spanId: string;
}
const context = new AsyncLocalStorage<Context>();
const propagation = new AsyncLocalStorage<boolean>();
let root: Context | undefined;

/** Keep an enumerated child environment free of ambient trace settings. */
export function withoutTracePropagation<T>(operation: () => T): T {
  return propagation.run(false, operation);
}

function enabled(): boolean {
  return process.env.JIG_TRACE === "1" || Boolean(process.env.JIG_TRACE_FILE);
}

function inherited(): Context {
  if (root) return root;
  const match =
    /^00-((?!0{32}-)[a-f0-9]{32})-((?!0{16}-)[a-f0-9]{16})-[a-f0-9]{2}$/i.exec(
      process.env.TRACEPARENT ?? "",
    );
  root = match
    ? { traceId: match[1] ?? "", spanId: match[2] ?? "" }
    : { traceId: randomBytes(16).toString("hex"), spanId: "" };
  return root;
}

/** The default trace root is independent of the consumer repository. */
function traceDirectory(): string {
  return join(homedir(), ".local", "state", "jig", "traces");
}

/** Propagate the current span even when the caller supplies a filtered environment. */
export function traceEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  if (propagation.getStore() === false || !enabled()) return env;
  const current = context.getStore() ?? inherited();
  return {
    ...env,
    JIG_TRACE: process.env.JIG_TRACE,
    JIG_TRACE_FILE: process.env.JIG_TRACE_FILE
      ? resolve(process.env.JIG_TRACE_FILE)
      : process.env.JIG_TRACE_FILE,
    TRACEPARENT: `00-${current.traceId}-${current.spanId || randomBytes(8).toString("hex")}-01`,
  };
}

/** JSON lines are appended synchronously so process exit cannot discard settled spans.
 * Diagnostics must never change an operation's result, including on a full disk. */
export async function span<T>(
  name: string,
  attrs: Attributes,
  fn: () => T | Promise<T>,
): Promise<T> {
  if (!enabled()) return fn();
  const parent = context.getStore() ?? inherited();
  const current = {
    traceId: parent.traceId,
    spanId: randomBytes(8).toString("hex"),
  };
  const start = currentIso();
  const clock = performance.now();
  let status = "ok";
  try {
    return await context.run(current, fn);
  } catch (error) {
    status = "error";
    throw error;
  } finally {
    try {
      // Resolved, so a relative file's directory is a real path: Windows
      // refuses to create ".", even recursively.
      const file = process.env.JIG_TRACE_FILE
        ? resolve(process.env.JIG_TRACE_FILE)
        : join(
            traceDirectory(),
            start.slice(0, 10),
            `${current.traceId}.jsonl`,
          );
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(
        file,
        `${JSON.stringify({
          trace_id: current.traceId,
          span_id: current.spanId,
          parent_id: parent.spanId || null,
          name,
          start,
          duration_ms: performance.now() - clock,
          status,
          attrs,
        })}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      swallow(
        error,
        "tracing could not append a settled span; preserving operation result",
      );
    }
  }
}

/** Trace days are machine-global, so removal tolerates a competing reaper. */
function removeTraceDay(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 3 });
}

/** A concurrent reaper may have removed the day first; that is not a failure. */
function removeDay(
  remove: (path: string) => void,
  path: string,
  failures: string[],
): void {
  try {
    remove(path);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      failures.push(`could not remove trace day ${basename(path)}`);
  }
}

/** Expire complete UTC trace days older than fourteen days; dry runs only report. */
export function reapTraceDays(
  del: boolean,
  now = currentMs(),
  directory = traceDirectory(),
  remove: (path: string) => void = removeTraceDay,
): { days: string[]; failures: string[] } {
  const days: string[] = [];
  const failures: string[] = [];
  const cutoff = isoFromMs(now - 14 * 86_400_000).slice(0, 10);
  try {
    // Oldest first, so failures report in the same order on every filesystem.
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.name) ||
        entry.name >= cutoff
      )
        continue;
      const timestamp = parseMs(`${entry.name}T00:00:00Z`);
      if (
        !Number.isFinite(timestamp) ||
        isoFromMs(timestamp).slice(0, 10) !== entry.name
      )
        continue;
      days.push(entry.name);
      if (del) removeDay(remove, join(directory, entry.name), failures);
    }
  } catch (error) {
    if (errnoCode(error) !== "ENOENT")
      failures.push("could not enumerate trace days");
  }
  return { days, failures };
}

/** Command timing carries only the executable basename and execution outcome. */
function traceCommand<T extends { code: number; timedOut: boolean }>(
  name: string,
  executable: string,
  timeoutSec: number | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const attrs = {
    command: executable.split(/[\\/]/).pop() ?? "",
    timeout_sec: timeoutSec,
    exit_code: 0,
    timed_out: false,
  };
  return span(name, attrs, async () => {
    const result = await fn();
    attrs.exit_code = result.code;
    attrs.timed_out = result.timedOut;
    return result;
  });
}

/** Whether a run's output is captured whole, so its headers can be read and taken off. */
function captured(opts: unknown): boolean {
  const o = opts as { stdout?: string; onOutput?: unknown };
  return (o.stdout ?? "pipe") === "pipe" && o.onOutput === undefined;
}

/**
 * One run of `gh`, admitted against the budget record of its credential's
 * quota owner and observed into it (`outbound/github-budget.ts`): a run the
 * record refuses is not started and answers `refuse`'s result, a failed run
 * naming when the limit clears. `attribution` is told the owner and the
 * limit the answer named, for the run's ledger row.
 */
async function governedRun<T extends GhRun, O>(
  args: string[],
  opts: O,
  refuse: (failure: OutboundFailure) => T,
  send: (argv: string[]) => Promise<T>,
  attribution: GhAttribution,
  deadlineAt: number,
): Promise<T> {
  const o = opts as {
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    cwd?: string;
  };
  // The host a call names (`--hostname`) is the one it sends to, so its
  // credential and owner are those of that host.
  const env = ghHostIn(args, o.env ?? process.env);
  // One deadline covers the wait for a probe, the owner's discovery, pacing
  // and the run: discovery gets what is left, and no run starts once it is
  // spent.
  const spentFailure = () =>
    refuse(
      outboundFailure(
        "unreachable",
        "the call's deadline was spent before it was sent; nothing was sent",
      ),
    );
  if (currentMs() >= deadlineAt) return spentFailure();
  // The working directory is the run's: a client that picks its account
  // per repository may pick it by the directory's remote.
  const owner = await forgeOwner(
    args,
    env,
    Math.max(0, deadlineAt - currentMs()),
    o.cwd,
  );
  if (currentMs() >= deadlineAt) return spentFailure();
  const governance = ghGovernance(args, {
    env,
    captured: captured(opts),
    ...(owner === undefined ? {} : { owner }),
    attribution,
  });
  if (governance === null) return send(args);
  const admitted = forgeGovernorPacingOn()
    ? await admitPaced(governance, deadlineAt, o.signal)
    : governance.admit();
  if ("failure" in admitted) return refuse(admitted.failure);
  if ("refused" in admitted) return refuse(admitted.refused);
  const late = endedFailure(deadlineAt, o.signal, "during budget admission");
  if (late !== null)
    return governance.observe(refuse(late), admitted.sentAt, 0);
  const began = currentMs();
  const result = await send(governance.argv);
  return governance.observe(result, admitted.sentAt, currentMs() - began);
}

/**
 * One request to the forge: counted for a parent reader, recorded in the
 * ledger, kept to the quota owner's budget record (`governedRun`) and, when
 * `held`, sent to no forge this run holds (`outbound/hold.ts`): the call
 * then answers `refuse`'s result, a failed run naming the earlier failure.
 * One deadline bounds the wait for a probe, discovery, pacing and the run;
 * a cancel of the caller's signal ends the waits, while a run already started
 * ends at the deadline.
 */
async function ghRequest<T extends GhRun, O extends { timeoutSec?: number }>(
  args: string[],
  opts: O,
  timeoutSec: number,
  run: (argv: string[], options: O) => Promise<T>,
  refuse: (failure: OutboundFailure) => T,
  held: boolean,
): Promise<T> {
  // A parent reader counts nested forge calls at dispatch, including timed-out reads.
  if (process.env.JIG_FORGE_CALL_COUNT_FILE) {
    try {
      appendFileSync(process.env.JIG_FORGE_CALL_COUNT_FILE, "1");
    } catch (err) {
      swallow(err, "forge call accounting must not prevent dispatch");
      console.error(
        `${FORGE_ACCOUNTING_UNAVAILABLE}: forge call accounting unavailable`,
      );
    }
  }
  // What governance learns of the run for its ledger row.
  const attribution: GhAttribution = {};
  const deadlineAt = currentMs() + timeoutSec * 1000;
  const remaining = () =>
    Math.max(1, Math.ceil((deadlineAt - currentMs()) / 1000));
  const controller = new AbortController();
  const external = (opts as { signal?: AbortSignal }).signal;
  const cancelled = () => controller.abort(external?.reason);
  external?.addEventListener("abort", cancelled, { once: true });
  if (external?.aborted) cancelled();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  const callOpts = { ...opts, signal: controller.signal };
  try {
    if (!held)
      return await recordGhAttempt(
        args,
        opts,
        () =>
          governedRun(
            args,
            callOpts,
            refuse,
            (argv) => run(argv, { ...opts, timeoutSec: remaining() }),
            attribution,
            deadlineAt,
          ),
        attribution,
      );
    // The run's elapsed time tells a 502/504 the forge ran out of time on
    // (`too-costly`, which the paged reader answers with a smaller page) from
    // a fault it answered at once (which holds the forge).
    let tookMs = 0;
    // A run the budget refuses never left the machine: it says nothing of the
    // forge, so the hold does not read it as an answer.
    const refusedHere = new WeakSet<object>();
    const refuseHere = (failure: OutboundFailure): T => {
      const refused = refuse(failure);
      refusedHere.add(refused);
      return refused;
    };
    return await recordGhAttempt(
      args,
      opts,
      () =>
        guarded(
          GITHUB,
          // Admission and the answer's record sit inside the hold, so a call
          // queued behind the probe is admitted after the probe's answer is
          // recorded.
          () =>
            governedRun(
              args,
              callOpts,
              refuseHere,
              async (argv) => {
                const began = currentMs();
                try {
                  return await run(argv, { ...opts, timeoutSec: remaining() });
                } finally {
                  tookMs = currentMs() - began;
                }
              },
              attribution,
              deadlineAt,
            ),
          (r) => ghRunFailure(r, tookMs),
          refuse,
          controller.signal,
          (r) => refusedHere.has(r),
        ),
      attribution,
    );
  } catch (error) {
    if (!controller.signal.aborted || error !== controller.signal.reason)
      throw error;
    return refuse({
      code: external?.aborted ? "unreachable" : "too-costly",
      reason: external?.aborted
        ? "GitHub call cancelled while waiting; nothing was sent"
        : "GitHub call deadline expired while waiting; nothing was sent",
    });
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", cancelled);
  }
}

/**
 * Shared gh boundary keeps its effective deadline and span metadata together
 * and sends each request through `ghRequest`. A captured `gh api --paginate`
 * read is sent a page at a time (`outbound/gh-paginate.ts`), each page a
 * request of its own, within the call's one deadline, or within
 * `pagedWholeSec` where the caller names a longer bound for the whole read.
 * A paged read left to gh is one process, so that bound is its deadline.
 */
function traceGhCall<
  T extends GhRun,
  O extends { timeoutSec?: number; pagedWholeSec?: number },
>(
  args: string[],
  opts: O,
  envDeadline: number,
  run: (argv: string[], options: O) => Promise<T>,
  refuse: (failure: OutboundFailure) => T,
  held = true,
): Promise<T> {
  const deadline =
    opts.timeoutSec === undefined
      ? envDeadline
      : Math.max(1, Math.min(envDeadline, opts.timeoutSec));
  const wholeSec = Math.max(deadline, opts.pagedWholeSec ?? deadline);
  // The host a call names is the one it sends to: accounting, governance
  // and paging all read the call's environment with it applied.
  const given = (opts as { env?: Record<string, string | undefined> }).env;
  const env = ghHostIn(args, given ?? process.env);
  const effective = env === (given ?? process.env) ? opts : { ...opts, env };
  const request = (argv: string[], timeoutSec: number) =>
    ghRequest(argv, effective, timeoutSec, run, refuse, held);
  const plan = forgeBudgetOn(env) ? pagePlan(args, captured(opts), env) : null;
  // A later page is addressed by the `Link` URL, which names no repository,
  // so the pages after the first keep the first page's scope: they are
  // charged to the same owner and sent with it as `GH_REPO`.
  let pinned: string | null | undefined;
  const paged = (argv: string[], timeoutSec: number) => {
    if (pinned === undefined) {
      pinned = ghRunScope(argv, env, (opts as { cwd?: string }).cwd);
      return request(argv, timeoutSec);
    }
    if (pinned === null) return request(argv, timeoutSec);
    const page = { ...effective, env: { ...env, GH_REPO: pinned } };
    return ghRequest(argv, page, timeoutSec, run, refuse, held);
  };
  return traceCommand("ghCall", "gh", deadline, async () => {
    const result = await (plan === null
      ? request(args, wholeSec)
      : drivePages(plan, paged, deadline, refuse, wholeSec));
    // What a reader ending on this call's failure is told of a spent limit.
    // A runner that reports no stderr has nothing to classify.
    if (typeof result.stderr === "string")
      noteForgeAnswer(ghRunFailure(result));
    return result;
  });
}

/** Adapt a process runner once, preserving its options and complete result type. */
export function traceRunner<
  T extends { code: number; timedOut: boolean; stderr?: string },
  O extends { timeoutSec?: number; stderr?: "pipe" | "inherit" | "ignore" },
>(
  fn: (argv: string[], opts: O) => Promise<T>,
  defaults: O,
): (argv: string[], opts?: O) => Promise<T> {
  return (argv, opts = defaults) =>
    traceCommand("run", argv[0] ?? "", opts.timeoutSec, async () => {
      const result = await fn(argv, opts);
      if (
        process.env.JIG_FORGE_CALL_COUNT_FILE &&
        result.stderr?.includes(FORGE_ACCOUNTING_UNAVAILABLE)
      )
        console.error(FORGE_ACCOUNTING_UNAVAILABLE);
      return result;
    });
}

const unheldForms = new WeakMap<object, unknown>();

/** The form of a runner `traceGhRunner` made that does not hold the forge; `undefined` for any other runner. */
export function unheldForm<R extends object>(runner: R): R | undefined {
  return unheldForms.get(runner) as R | undefined;
}

/**
 * Adapt the gh boundary without copying its deadline, span or hold bookkeeping;
 * `refuse` is a held call's result. `unheldForm` gives the runner that does
 * not hold, for a caller that applies the hold around its own retry.
 */
export function traceGhRunner<
  T extends GhRun,
  O extends { timeoutSec?: number; pagedWholeSec?: number },
>(
  run: (argv: string[], opts: O) => Promise<T>,
  timeout: () => number,
  defaults: O,
  refuse: (failure: OutboundFailure) => T,
): (args: string[], opts?: O) => Promise<T> {
  const through =
    (held: boolean) =>
    (args: string[], opts: O = defaults) =>
      traceGhCall(args, opts, timeout(), run, refuse, held);
  const runner = through(true);
  unheldForms.set(runner, through(false));
  // Discovery runs inside the request that needs the owner, which may be
  // the hold's probe: it must not wait on that hold, so it takes the form
  // that does not hold the forge.
  const unheld = through(false);
  setDiscoveryRunner((args, env, timeoutSec, cwd) =>
    unheld(args, {
      ...defaults,
      env,
      timeoutSec,
      ...(cwd === undefined ? {} : { cwd }),
    } as O),
  );
  return runner;
}
