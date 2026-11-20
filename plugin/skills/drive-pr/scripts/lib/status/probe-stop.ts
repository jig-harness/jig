/** Evidence from a status probe whose exit the driver passed through. */
import { redactReportText } from "../../../../../shared/closing-report.ts";
import { swallow } from "../../../../../shared/errors.ts";
import { type Infer, matches, s } from "../../../../../shared/shapes.ts";
import { terminal } from "./terminal-states.ts";

const PREFIX = "drive.ts: status probe stopped: ";
const REASON_LIMIT = 512;
const FAILURE_KINDS = ["read", "quota"] as const;
export type ProbeFailure = (typeof FAILURE_KINDS)[number];

export const PROBE_STOP_SHAPE = s.object({
  code: s.integer({ minimum: 1, maximum: 255 }),
  state: s.string({ pattern: "^[A-Z][A-Z0-9_]*$", maxLength: 64 }),
  reason: s.string({
    minLength: 1,
    maxLength: REASON_LIMIT,
    pattern: "^[^\\r\\n]+$",
  }),
  failure: s.optional(s.enum(FAILURE_KINDS)),
});

export type ProbeStop = Infer<typeof PROBE_STOP_SHAPE>;

function safeReason(reason: string): string {
  const text = redactReportText(reason)
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
  return text.length <= REASON_LIMIT
    ? text
    : `${text.slice(0, REASON_LIMIT - 1)}…`;
}

export function probeStopOf(value: unknown): ProbeStop | null {
  if (!matches(PROBE_STOP_SHAPE, value)) return null;
  const { code, state, failure } = value;
  const reason = safeReason(value.reason);
  if (reason === "") return null;
  return { code, state, reason, ...(failure === undefined ? {} : { failure }) };
}

export function recordProbeStop(
  code: number,
  status: Record<string, unknown>,
): ProbeStop | null {
  if (typeof status.reason !== "string") return null;
  const probe = probeStopOf({
    code,
    state: status.state,
    reason: safeReason(status.reason),
    failure: status.failure,
  });
  if (probe !== null) console.error(`${PREFIX}${JSON.stringify(probe)}`);
  return probe;
}

/** The last status-probe stop printed by the driver, from bounded launch output. */
export function readProbeStop(context: string): ProbeStop | null {
  const line = context.split("\n").findLast((line) => line.startsWith(PREFIX));
  if (line === undefined) return null;
  try {
    return probeStopOf(JSON.parse(line.slice(PREFIX.length)));
  } catch (error) {
    swallow(error, "an incomplete status probe stop line carries no evidence");
    return null;
  }
}

/** Exit 1 also signals non-read failures. Only the failing read can classify itself. */
export function probeFailure(probe: ProbeStop): ProbeFailure | null {
  return probe.code === 1 ? (probe.failure ?? null) : null;
}

export function setProbeFailure(
  report: { failure?: ProbeFailure },
  failure?: ProbeFailure,
): void {
  if (failure === undefined) delete report.failure;
  else report.failure = failure;
}

/** Record an indeterminate status caused by a forge read. */
export function readFailure(
  report: { state: string; reason: string; failure?: ProbeFailure },
  reason: string,
): number {
  const code = terminal(report, "INDETERMINATE", reason);
  setProbeFailure(report, "read");
  return code;
}
