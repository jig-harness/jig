/**
 * The usage-limit wall an interactive session met, read from that
 * session's own record with the drive's quota adapters (`detectQuotaBlock`),
 * matched on the vendor session id the tick minted at its launch. It runs
 * in a child given the account's environment (`run.ts quota`), so the
 * adapter reads the account's configuration directory, as the identity
 * check does.
 *
 * Besides the wall, it says whether the session's last record is still that
 * wall: a session that went on after the wall (a person typed, the agent
 * resumed) is no longer waiting on it, and gets no nudge.
 */
import { readFileSync } from "node:fs";
import { detectQuotaBlock } from "../../skills/drive-pr/scripts/lib/quota/index.ts";
import { swallow } from "../../shared/errors.ts";
import { isMapping } from "../../shared/config-layers.ts";

/** What the probe prints: the wall, or `null`. */
export interface ProbedWall {
  observedAt: string;
  resetAt: string | null;
  window: string;
  evidence: string;
  /** Whether the session's last record is still the wall. */
  last: boolean;
}

/** The last record of a session file, parsed; `null` when it does not read. */
function lastRecord(path: string): Record<string, unknown> | null {
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const value: unknown = JSON.parse(lines.at(-1) ?? "");
    return isMapping(value) ? value : null;
  } catch (error) {
    swallow(error, `${path}'s last record does not read`);
    return null;
  }
}

function seconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** The wall the session `sessionId` met in `cwd` since `since`, if any. */
export function probeWall(
  sessionId: string,
  cwd: string,
  since: Date,
  now: Date,
): ProbedWall | null {
  const block = detectQuotaBlock({
    cwd,
    since,
    now,
    correlation: { vendor: "claude", sessionId },
  });
  if (block === null) return null;
  const last = lastRecord(block.source);
  const at =
    typeof last?.timestamp === "string" ? Date.parse(last.timestamp) : NaN;
  return {
    observedAt: block.observedAt.toISOString(),
    resetAt: block.resetAt?.toISOString() ?? null,
    window: block.window,
    evidence: block.evidence,
    last:
      Number.isFinite(at) &&
      seconds(at) === seconds(block.observedAt.getTime()),
  };
}

/** Whether a parsed value is what the probe prints for a wall. */
export function isProbedWall(value: unknown): value is ProbedWall {
  return (
    isMapping(value) &&
    typeof value.observedAt === "string" &&
    Number.isFinite(Date.parse(value.observedAt)) &&
    (value.resetAt === null ||
      (typeof value.resetAt === "string" &&
        Number.isFinite(Date.parse(value.resetAt)))) &&
    typeof value.evidence === "string" &&
    typeof value.last === "boolean"
  );
}
