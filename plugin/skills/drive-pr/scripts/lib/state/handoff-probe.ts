import { probeStopOf } from "../status/probe-stop.ts";
import { lastStopEvent } from "./events.ts";
import type { DriveState } from "./schema.ts";

const PROBE_STOP_NOTE = "**Last status probe stop**: ";

export function isProbeStopNote(line: string): boolean {
  return line.startsWith(PROBE_STOP_NOTE);
}

export function appendProbeStop(content: string, state: DriveState): string {
  const stop = probeStopOf(lastStopEvent(state.events ?? [])?.probe);
  return stop === null
    ? content
    : `${content.trimEnd()}\n\n${PROBE_STOP_NOTE}${stop.state} (exit ${stop.code}) — ${stop.reason}\n`;
}
