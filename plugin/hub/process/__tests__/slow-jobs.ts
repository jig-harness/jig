/**
 * A module of jobs for the serve tests: `slow` holds its thread busy for
 * `SLOW_MS`, marking when it starts and ends in files named by the process
 * id, which the worker thread shares with the test.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../../../shared/outcome.ts";
import type { HubPorts } from "../../core/ports.ts";
import type { JobHandler } from "../../core/scheduling.ts";

export const SLOW_MS = 3_000;
export const startedMarker = () =>
  join(tmpdir(), `jig-hub-slow-${process.pid}-started`);
export const endedMarker = () =>
  join(tmpdir(), `jig-hub-slow-${process.pid}-ended`);

export const JOB_NAMES: readonly string[] = ["slow"];

export function jobHandlers(_ports: HubPorts): ReadonlyMap<string, JobHandler> {
  return new Map<string, JobHandler>([
    [
      "slow",
      async () => {
        writeFileSync(startedMarker(), "");
        const until = performance.now() + SLOW_MS;
        // Busy on purpose: a thread that ran this could answer nothing else.
        while (performance.now() < until) {
          // Spin.
        }
        writeFileSync(endedMarker(), "");
        return ok(undefined);
      },
    ],
  ]);
}
