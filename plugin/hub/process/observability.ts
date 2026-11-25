/**
 * The process adapter's observability port: one JSON line per event,
 * metric, span or defect on standard error, where the resident job's
 * scheduler keeps it (the systemd journal, launchd's log file). An
 * exporter to a collector is a later step.
 */
import type { Defect } from "../../shared/outcome.ts";
import { ok } from "../../shared/outcome.ts";
import { currentMs, isoFromMs } from "../../shared/time.ts";
import type { ObservabilityPort } from "../core/observability.ts";
import type { UnitContext } from "../core/unit.ts";

/** Where a line goes; standard error unless a test collects them. */
export type LineWriter = (line: string) => void;

const toStderr: LineWriter = (line) => {
  process.stderr.write(`${line}\n`);
};

export function processObservability(
  write: LineWriter = toStderr,
  now: () => number = currentMs,
): ObservabilityPort {
  const line = (context: UnitContext, kind: string, body: object) => {
    write(
      JSON.stringify({
        ...body,
        at: isoFromMs(now()),
        kind,
        unit: context.unit,
      }),
    );
    return ok(undefined);
  };
  return {
    event: (context, event) => line(context, "event", event),
    metric: (context, sample) => line(context, "metric", sample),
    span: (context, span) => line(context, "span", span),
    defect: (context, defect: Defect) =>
      line(context, "defect", {
        message: defect.message,
        stack: defect.stack ?? null,
      }),
  };
}
