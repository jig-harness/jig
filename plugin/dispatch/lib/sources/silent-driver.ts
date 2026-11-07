/**
 * What this host shows of a silent ledger's driver: whether its run ended,
 * so the plan may take the drive over although no launch record of this
 * machine and no launch claim of another host's started it. Only the host
 * the driver ran on can tell, so a ledger whose clone names another host,
 * or names no run, stays a person's. On this host the answer is drive-pr's
 * own (`driver-presence.ts`), read-only, from the clone the ledger names:
 * the run is gone only on the evidence that drive-pr's recovery accepts, and
 * a run it cannot show ended is never taken for one.
 */
import { resolve } from "node:path";
import {
  helperTimeoutSeconds,
  run,
  tsArgv,
} from "../../../skills/drive-pr/scripts/lib/proc.ts";
import type { Ledger } from "../../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { hostLabel } from "../../../skills/drive-pr/scripts/lib/state/ledger-mirror.ts";
import { swallow } from "../../../shared/errors.ts";
import { isRecord } from "../../../shared/guards.ts";

/** Whether this host shows a silent ledger's driver gone, and what it showed. */
export interface DriverPresence {
  gone: boolean;
  why: string;
}

const PRESENCE = resolve(
  import.meta.dir,
  "../../../skills/drive-pr/scripts/driver-presence.ts",
);

/** What this host shows of the driver PR `pr`'s silent ledger names. */
export async function driverPresence(
  pr: number,
  ledger: Ledger,
): Promise<DriverPresence> {
  const { clone, started } = ledger.driver;
  const at = clone.lastIndexOf("@");
  const key = at < 0 ? "" : clone.slice(0, at);
  if (at < 0 || clone.slice(at + 1) !== hostLabel())
    return {
      gone: false,
      why: `its driver's clone (${clone}) is not on this host, whose process table cannot show that driver's run ended`,
    };
  if (started === undefined || started === "")
    return {
      gone: false,
      why: "its ledger names no run of its driver for this host to look for",
    };
  const result = await run(tsArgv(PRESENCE, [String(pr), key, started]), {
    stderr: "pipe",
    timeoutSec: helperTimeoutSeconds(),
  });
  const said = result.code === 0 ? parsed(result.stdout) : null;
  if (said === null)
    return {
      gone: false,
      why: `this host could not show whether its driver's run ended (driver-presence.ts exited ${result.code}${result.stderr.trim() === "" ? "" : `: ${result.stderr.trim().split("\n")[0]}`})`,
    };
  return { gone: said.verdict === "gone", why: said.why };
}

function parsed(stdout: string): { verdict: string; why: string } | null {
  try {
    const v: unknown = JSON.parse(stdout);
    return isRecord(v) &&
      typeof v.verdict === "string" &&
      typeof v.why === "string"
      ? { verdict: v.verdict, why: v.why }
      : null;
  } catch (error) {
    swallow(error, "driver-presence.ts printed no verdict");
    return null;
  }
}
