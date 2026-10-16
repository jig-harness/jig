/**
 * Detached work: a promise started with no caller waiting for it. Such work
 * has nowhere to propagate a failure to, so whatever it throws either becomes
 * an unhandled rejection, which the runtime reports once and may stop the
 * process on, or is dropped by a `.catch(() => {})` and never seen. Both lose
 * the cause.
 *
 * `runDetached` starts the work and reports a failure through the reporter
 * the caller gives it, with the error, its cause chain and whether it is a
 * defect; the chain it starts can never reject. When the reporter itself
 * throws, one line goes to the fallback (standard error by default) naming
 * the work and nothing else: raw standard error bypasses a logger's
 * redaction, so untrusted error text never reaches it.
 *
 * `installUnhandledRejectionListener` is the process-level backstop for the
 * detached work that did not go through the helper: it reports the same way
 * and never throws. A process with such a listener no longer stops on an
 * unhandled rejection, so the fix for a reported one is to route the work
 * through `runDetached`, never to remove the listener.
 *
 * Portable: no imports. A repository plugs in its own logger as `report` and
 * its own defect type as `isDefect`.
 */

export interface DetachedFailure {
  /** What the work was, for the reader of the report. */
  label: string;
  error: unknown;
  /** Whether `isDefect` classed the error as a bug rather than a failure. */
  defect: boolean;
  /** The error's name, or the type of a reason that is not an error. */
  errorName: string;
  /** The error's message, or the reason printed; never the thing thrown on. */
  message: string;
  /** The messages along `error.cause`, nearest first. */
  causes: string[];
  stack?: string;
  context?: Record<string, unknown>;
}

/**
 * What a callback here returns: nothing. `void` alone would accept an async
 * function, whose promise carries its failure where nobody waits for it; the
 * union with `undefined` refuses one and still accepts a logger method
 * declared to return `void`. `ReturnType<() => void>` spells `void` where
 * the linter accepts it.
 */
export type Synchronous = ReturnType<() => void> | undefined;

export interface DetachedOptions {
  /** What the work is, as the report names it. */
  label: string;
  /** Where a failure goes: a structured logger's error or warn method. */
  report: (failure: DetachedFailure) => Synchronous;
  /**
   * Tells a bug from a failure; "never a defect" by default. One that throws
   * on a reason classes it as a failure, not a defect.
   */
  isDefect?: (error: unknown) => boolean;
  /** Fields carried into the report, for correlation. */
  context?: Record<string, unknown>;
  /**
   * The last resort when `report` throws or its returned promise rejects;
   * standard error by default.
   */
  fallback?: (line: string) => Synchronous;
}

/** How far a cause chain is followed, so a cycle cannot loop the report. */
const MAX_CAUSES = 10;

/**
 * `String(value)` that cannot throw. A report field that throws would hide
 * the failure it describes, so this one never does.
 */
export function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    return `[unprintable ${typeof value}]`;
  }
}

/**
 * Run a read of the failure that may throw (a getter, or `instanceof` on a
 * revoked proxy), answering `otherwise` when it does.
 */
function attempt<T>(read: () => T, otherwise: T): T {
  try {
    return read();
  } catch {
    return otherwise;
  }
}

const isError = (value: unknown): value is Error =>
  attempt(() => value instanceof Error, false);

/** The cause an error names, or `undefined` when it names none or throws. */
const causeOf = (value: unknown): unknown =>
  isError(value) ? attempt(() => value.cause, undefined) : undefined;

/** An error's message, or the value printed; never throws. */
const messageOf = (value: unknown): string =>
  isError(value)
    ? attempt(() => safeString(value.message), "[unreadable message]")
    : safeString(value);

/** The messages along `error.cause`, nearest first, bounded. Never throws. */
export function causeChain(error: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>([error]);
  let current = causeOf(error);
  while (
    current !== undefined &&
    !seen.has(current) &&
    out.length < MAX_CAUSES
  ) {
    seen.add(current);
    out.push(messageOf(current));
    current = causeOf(current);
  }
  return out;
}

/**
 * The report of one failure: what a logger receives. Never throws: each
 * field is read on its own, one that cannot be read is described as such,
 * and `error` is always the reason itself.
 */
export function describeFailure(
  label: string,
  error: unknown,
  defect: boolean,
  context?: Record<string, unknown>,
): DetachedFailure {
  const asError = isError(error);
  const failure: DetachedFailure = {
    label,
    error,
    defect,
    errorName: asError
      ? attempt(() => safeString(error.name), "[unreadable name]")
      : typeof error,
    message: messageOf(error),
    causes: causeChain(error),
  };
  const stack = asError ? attempt(() => error.stack, undefined) : undefined;
  if (typeof stack === "string") failure.stack = stack;
  if (context !== undefined) failure.context = context;
  return failure;
}

const writeStderr = (line: string): void => {
  process.stderr.write(line);
};

/**
 * The `then` of a value that is a promise-like, or `undefined`. A `then`
 * getter that throws throws here.
 */
function thenOf(value: unknown): ((...args: unknown[]) => unknown) | undefined {
  if ((typeof value !== "object" && typeof value !== "function") || !value)
    return undefined;
  const then = (value as { then?: unknown }).then;
  return typeof then === "function"
    ? (then as (...args: unknown[]) => unknown)
    : undefined;
}

/** How many hand-written `then`s in a row are followed. */
const SETTLE_DEPTH = 8;

/**
 * Attach `onRejected` to whatever a callback returned, if it is a
 * promise-like, so its failure is handled instead of becoming an unhandled
 * rejection. A `then` that cannot be read, or that throws, is treated as a
 * rejection. Whatever a hand-written `then` returns is settled the same way,
 * since an `async then` rejects through the promise it returns, which
 * neither its caller nor promise resolution handles; a native promise's
 * `then` returns one this handler already settles, so the chain ends there,
 * at any depth. A chain of hand-written `then`s longer than the bound is
 * treated as a rejection: what it would end in is never observed, so it
 * cannot be called reported. `onRejected` runs at most once.
 */
function settle(returned: unknown, onRejected: () => void): void {
  let rejected = false;
  const once = () => {
    if (rejected) return;
    rejected = true;
    onRejected();
  };
  let value = returned;
  for (let depth = 0; ; depth++) {
    try {
      const then = thenOf(value);
      if (then === undefined) return;
      if (then === Promise.prototype.then) {
        then.call(value, undefined, once);
        return;
      }
      if (depth === SETTLE_DEPTH) {
        once();
        return;
      }
      value = then.call(value, undefined, once);
    } catch {
      once();
      return;
    }
  }
}

/**
 * Write the withheld-details line to the fallback. When the fallback fails,
 * synchronously or through a promise it returns, one write to standard
 * error is the last attempt, and its own failure is swallowed: there is
 * nowhere left, and nothing here may retrigger the process listener.
 */
function writeFallback(
  fallback: (line: string) => Synchronous,
  line: string,
): void {
  const lastResort = () => {
    attempt(() => writeStderr(line), undefined);
  };
  try {
    settle(fallback(line), lastResort);
  } catch {
    if (fallback !== writeStderr) lastResort();
  }
}

/**
 * Report one failure of detached work. Never throws and leaves no rejected
 * promise behind: when `report` throws, or returns a promise that rejects,
 * the fallback gets one line that names the work and says the details were
 * withheld. The reason may be any value, and a predicate over any value can
 * throw (`instanceof` on a revoked proxy does), so a throwing `isDefect`
 * counts as "not a defect", a field that cannot be read is described as
 * unreadable, and the report still goes out with the reason itself.
 */
export function reportDetachedFailure(
  error: unknown,
  options: DetachedOptions,
): void {
  const { label, report, isDefect, context, fallback = writeStderr } = options;
  const defect =
    isDefect === undefined ? false : attempt(() => isDefect(error), false);
  const reporterFailed = () =>
    writeFallback(
      fallback,
      `${label}: a detached failure could not be reported (the reporter threw; defect=${defect}; details withheld)\n`,
    );
  try {
    settle(
      report(describeFailure(label, error, defect, context)),
      reporterFailed,
    );
  } catch {
    reporterFailed();
  }
}

/**
 * Start work nobody awaits. The chain is not returned: a caller cannot await
 * it, and it can never reject. A thunk that throws before returning a
 * promise is reported the same way as a rejected one.
 */
export function runDetached(
  work: Promise<unknown> | (() => Promise<unknown>),
  options: DetachedOptions,
): void {
  const report = (error: unknown) => reportDetachedFailure(error, options);
  try {
    const promise = typeof work === "function" ? work() : work;
    void Promise.resolve(promise).catch(report);
  } catch (error) {
    report(error);
  }
}

/**
 * Install the process-level listener once per entry point, right after the
 * logger exists. Returns a disposer that removes it. The listener never
 * throws, whatever the reason or the logger does.
 */
export function installUnhandledRejectionListener(
  options: Omit<DetachedOptions, "label"> & { label?: string },
): () => void {
  const label = options.label ?? "unhandled rejection";
  const listener = (reason: unknown): void => {
    reportDetachedFailure(reason, { ...options, label });
  };
  process.on("unhandledRejection", listener);
  return () => {
    process.off("unhandledRejection", listener);
  };
}
