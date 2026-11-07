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
import { isRecord } from "../../../shared/guards.ts";
import { failureText } from "../text.ts";

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
  const said = answerOf(result);
  if ("unread" in said)
    return {
      gone: false,
      why: `this host could not show whether its driver's run ended (driver-presence.ts ${said.unread})`,
    };
  return { gone: said.verdict === "gone", why: said.why };
}

/** The helper's verdict, or what it did instead of printing one. */
function answerOf(result: {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}): { verdict: string; why: string } | { unread: string } {
  if (result.timedOut)
    return { unread: `did not answer within ${helperTimeoutSeconds()}s` };
  if (result.code !== 0) {
    const first = result.stderr.trim().split("\n")[0] ?? "";
    return {
      unread: `exited ${result.code}${first === "" ? "" : `: ${first}`}`,
    };
  }
  let v: unknown;
  try {
    v = JSON.parse(result.stdout);
  } catch (error) {
    return { unread: `printed no verdict: ${failureText(error)}` };
  }
  return isRecord(v) &&
    typeof v.verdict === "string" &&
    typeof v.why === "string"
    ? { verdict: v.verdict, why: v.why }
    : { unread: "printed an answer without a verdict and a reason" };
}
