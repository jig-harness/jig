/**
 * One unit of the hub's work, and the defect boundary around it
 * ([ADR-0012](../../../docs/adr/ADR-0012-failures-as-values.md),
 * [design/control-plane.md § Concurrency and failures](../../../design/control-plane.md#concurrency-and-failures)).
 *
 * A unit is one webhook delivery, one host call or other request, one run
 * of a scheduled job. `runUnit` gives it one cancellation signal and one
 * deadline, which it passes into every port call it makes, and is the one
 * place that unit's defects are caught: whatever the work throws, a
 * `Defect` or anything else, becomes a failed outcome with the code
 * `defect` and is reported once through the observability port, with its
 * stack. A defect ends that unit only. When the adapter stops the unit, the
 * signal aborts and the unit answers `aborted` at once, and work is never
 * started for a unit already stopped. When the deadline passes first, the
 * signal aborts, every port call still running sees it, and the unit
 * answers `deadline-passed` without waiting for the work to notice.
 *
 * Times are integer milliseconds: the deadline is epoch milliseconds read
 * from the injected clock, never from a global.
 */
import {
  Defect,
  failed,
  type Failure,
  type Outcome,
} from "../../shared/outcome.ts";
import type { HubPorts } from "./ports.ts";

/** What every port call receives: the unit's signal and its deadline. */
export interface UnitContext {
  /** The unit's name, for telemetry (`webhook:github`, `job:sweep`). */
  readonly unit: string;
  /** Aborts when the deadline passes or the adapter stops the unit. */
  readonly signal: AbortSignal;
  /** When the unit's time is up, epoch milliseconds. */
  readonly deadlineAt: number;
}

/** How the boundary itself fails a unit; the work's own codes pass through. */
export type UnitFailureCode = "deadline-passed" | "defect" | "aborted";

export interface UnitSpec {
  /** The unit's name, as `UnitContext.unit` carries it. */
  readonly name: string;
  /** How long the unit may run, a positive whole number of milliseconds. */
  readonly timeoutMs: number;
  /** The adapter's own signal, when it can stop a unit early (a shutdown). */
  readonly stop?: AbortSignal;
}

/** What the work returns, or the boundary's failure. */
export type UnitOutcome<T, Code extends string> = Outcome<
  T,
  Code | UnitFailureCode
>;

/** What was thrown as text; a value that cannot be converted (a null-prototype object, a throwing `toString`) is named by a constant. */
function describe(thrown: unknown): string {
  try {
    return thrown instanceof Error ? thrown.message : String(thrown);
  } catch {
    return "a value that cannot be converted to text";
  }
}

/** A thrown value as a `Defect`, keeping what was thrown as its cause. */
function asDefect(thrown: unknown): Defect {
  if (thrown instanceof Defect) return thrown;
  return new Defect(`a unit threw: ${describe(thrown)}`, { cause: thrown });
}

/** Reports a defect; a reporter that fails or throws has nowhere further to report. */
function report(
  ports: Pick<HubPorts, "observability">,
  context: UnitContext,
  defect: Defect,
): void {
  try {
    ports.observability.defect(context, defect);
  } catch {
    // The observability port is the last place a defect can go; a throw
    // from it leaves only the unit's failed outcome to say what happened.
  }
}

/** The failure a unit answers with when its deadline passes first. */
function lateFailure(spec: UnitSpec): Failure<"deadline-passed"> {
  return failed(
    "deadline-passed",
    `${spec.name} did not finish within ${spec.timeoutMs} ms`,
  ).failure;
}

/** The failure a unit answers with when the adapter stopped it. */
function stoppedFailure(spec: UnitSpec): {
  ok: false;
  failure: Failure<"aborted">;
} {
  return failed("aborted", `${spec.name} was stopped before it finished`);
}

/** The failure a unit answers with when it threw, reported once. */
function defectFailure(
  ports: Pick<HubPorts, "observability">,
  context: UnitContext,
  thrown: unknown,
): { ok: false; failure: Failure<"defect"> } {
  const defect = asDefect(thrown);
  report(ports, context, defect);
  return failed("defect", defect.message, defect);
}

/**
 * Runs `work` as one unit: with its own signal and deadline, under the
 * defect boundary. It never throws and never rejects; a defect the work
 * throws after its deadline passed is still reported.
 */
export async function runUnit<T, Code extends string>(
  ports: Pick<HubPorts, "clock" | "observability">,
  spec: UnitSpec,
  work: (context: UnitContext) => Promise<Outcome<T, Code>>,
): Promise<UnitOutcome<T, Code>> {
  const controller = new AbortController();
  let context: UnitContext = {
    unit: spec.name,
    signal: controller.signal,
    deadlineAt: 0,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settleStopped: (() => void) | undefined;
  const onStop = () => {
    controller.abort(spec.stop?.reason);
    settleStopped?.();
  };
  try {
    if (!Number.isInteger(spec.timeoutMs) || spec.timeoutMs <= 0)
      throw new Defect(
        `a unit's timeout must be a positive whole number of milliseconds, not ${spec.timeoutMs}`,
      );
    context = { ...context, deadlineAt: ports.clock.now() + spec.timeoutMs };
    const unit = context;
    if (spec.stop?.aborted) {
      controller.abort(spec.stop.reason);
      return stoppedFailure(spec);
    }
    spec.stop?.addEventListener("abort", onStop, { once: true });
    const stopped = new Promise<{ ok: false; failure: Failure<"aborted"> }>(
      (resolve) => {
        settleStopped = () => resolve(stoppedFailure(spec));
      },
    );
    const late = new Promise<{
      ok: false;
      failure: Failure<"deadline-passed">;
    }>((resolve) => {
      timer = setTimeout(() => {
        const failure = lateFailure(spec);
        // A `TimeoutError`, as `AbortSignal.timeout` gives, so a `fetch`
        // the signal stops fails as the outbound library's `unreachable`.
        controller.abort(new DOMException(failure.reason, "TimeoutError"));
        resolve({ ok: false, failure });
      }, spec.timeoutMs);
    });
    const running = Promise.resolve()
      .then(() => work(unit))
      .catch((thrown: unknown) => defectFailure(ports, unit, thrown));
    return await Promise.race([running, late, stopped]);
  } catch (thrown) {
    return defectFailure(ports, context, thrown);
  } finally {
    clearTimeout(timer);
    spec.stop?.removeEventListener("abort", onStop);
  }
}
