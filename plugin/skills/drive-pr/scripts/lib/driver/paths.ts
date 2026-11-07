/** Resolve sibling command paths from the installed plugin, independently of the consumer working directory. */
import { dirname, join, resolve } from "node:path";

import { fileURLToPath } from "node:url";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const driveState = join(here, "drive-state.ts");

export const driveStatus = join(here, "drive-status.ts");

export const ciHold = join(here, "ci-hold.ts");

export const loopMetrics = join(here, "loop-metrics.ts");

export const markReady = join(here, "mark-ready.ts");

export const captureIntentChain = join(here, "capture-intent-chain.ts");

export const drives = join(here, "drives.ts");

export const driveTs = join(here, "drive.ts");

export const reconcileRepliedThreads = join(
  here,
  "reconcile-replied-threads.ts",
);
