/** The driver metadata shared by ledger publication and park admission. */
import type { LedgerDriver } from "./ledger.ts";
import type { LedgerDriverEnv } from "./ledger-mirror.ts";
import { personStopFor } from "./person-stop.ts";

export function ledgerDriverRecord(
  driver: LedgerDriverEnv | null,
  stateDir: string | undefined,
  pr: string,
): LedgerDriver {
  return {
    actor: driver?.actor ?? "park-admission",
    clone: driver?.clone ?? "park-admission",
    recoveryVersion: 1,
    ...(stateDir === undefined
      ? {}
      : personStopFor(stateDir, pr, driver?.started)),
    heartbeat: new Date().toISOString(),
    state: driver?.stopped === undefined ? "running" : "stopped",
    ...(typeof driver?.stopped === "number" ? { exit: driver.stopped } : {}),
    ...(driver?.started === undefined ? {} : { started: driver.started }),
    ...(driver?.floor == null ? {} : { position: driver.floor }),
  };
}
