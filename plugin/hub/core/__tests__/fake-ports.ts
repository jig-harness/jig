/**
 * In-memory ports for the core's tests: each records the context every
 * call received, and answers from plain maps. Not an implementation of
 * any port's contract beyond what the tests read.
 */
import type { Defect, Outcome } from "../../../shared/outcome.ts";
import { failed, ok } from "../../../shared/outcome.ts";
import type { HubPorts } from "../ports.ts";
import type { UnitContext } from "../unit.ts";

export interface FakePorts extends HubPorts {
  /** Every port call's context, in order, with the port and method it reached. */
  readonly calls: Array<{ call: string; context: UnitContext }>;
  readonly defects: Defect[];
  readonly rows: Map<string, unknown>;
  /** Moves the pinned clock. */
  advance(ms: number): void;
}

export function fakePorts(startMs = 1_800_000_000_000): FakePorts {
  let now = startMs;
  const calls: FakePorts["calls"] = [];
  const defects: Defect[] = [];
  const rows = new Map<string, unknown>();
  const seen = (call: string, context: UnitContext) =>
    calls.push({ call, context });
  const aborted = <Code extends string>(
    context: UnitContext,
    code: Code,
  ): Outcome<never, Code> | null =>
    context.signal.aborted ? failed(code, "the unit was stopped") : null;
  return {
    calls,
    defects,
    rows,
    advance: (ms) => {
      now += ms;
    },
    clock: { now: () => now },
    storage: {
      run: async (context, partition, op, input) => {
        seen(`storage.${op.name}`, context);
        const stopped = aborted(context, "aborted");
        if (stopped) return stopped;
        const key = `${partition}/${op.name}`;
        if (op.kind === "change") rows.set(key, input);
        return ok(rows.get(key) as never);
      },
    },
    serving: {
      serve: async (context) => {
        seen("serving.serve", context);
        return ok(undefined);
      },
    },
    scheduling: {
      schedule: async (context) => {
        seen("scheduling.schedule", context);
        return ok(undefined);
      },
      runSoon: async (context) => {
        seen("scheduling.runSoon", context);
        return ok(undefined);
      },
      cancel: async (context) => {
        seen("scheduling.cancel", context);
        return ok(undefined);
      },
    },
    outbound: {
      call: async (context) => {
        seen("outbound.call", context);
        if (context.signal.aborted)
          return {
            ok: false,
            failure: { code: "unreachable", reason: "the unit was stopped" },
          };
        return ok({ status: 200, body: {}, notModified: false });
      },
    },
    observability: {
      event: (context) => {
        seen("observability.event", context);
        return ok(undefined);
      },
      metric: (context) => {
        seen("observability.metric", context);
        return ok(undefined);
      },
      span: (context) => {
        seen("observability.span", context);
        return ok(undefined);
      },
      defect: (context, defect) => {
        seen("observability.defect", context);
        defects.push(defect);
        return ok(undefined);
      },
    },
  };
}
