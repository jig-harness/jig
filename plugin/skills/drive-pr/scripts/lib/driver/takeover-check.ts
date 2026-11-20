import { newerClaim } from "../state/ledger.ts";
import { readLedgerSnapshot } from "../state/ledger-forge.ts";
import {
  LEDGER_DRIVER_ENV,
  ledgerDriverFromEnv,
} from "../state/ledger-mirror.ts";
import { TAKEN_OVER_EXIT } from "./settings.ts";

const TAKEOVER_POLL_MS = 60_000;

async function checkForNewerClaim(
  pr: string,
): Promise<number | null | "unread"> {
  const driver = ledgerDriverFromEnv();
  if (driver === null || driver.floor === null) return "unread";
  const snapshot = await readLedgerSnapshot(pr, driver.login);
  if (typeof snapshot === "string") return "unread";
  const claim = newerClaim(
    snapshot.claims,
    driver.floor,
    driver.clone,
    driver.claim,
  );
  if (claim === null) return null;
  console.error(
    `drive.ts: taken over. Another clone (${claim.claim.actor}) claimed PR #${pr}'s drive in comment ${claim.id}, which beats this driver's own position (${driver.claim === null ? driver.floor : `its claim ${driver.claim.id}`}); stopping without another pass. That clone drives now.`,
  );
  // This driver no longer writes the ledger: it is the successor's.
  delete process.env[LEDGER_DRIVER_ENV];
  return TAKEN_OVER_EXIT;
}

/** Read fresh before a pass is dispatched or after a ledger renewal. */
export async function standDownOnNewerClaim(
  pr: string,
): Promise<number | null> {
  const result = await checkForNewerClaim(pr);
  return result === "unread" ? null : result;
}

/** Pace successful round-boundary reads for this drive only. */
export function roundBoundaryTakeoverCheck(
  pr: string,
  now = () => performance.now(),
): () => Promise<number | null> {
  let dueAt = Number.NEGATIVE_INFINITY;
  return async () => {
    const startedAt = now();
    if (startedAt < dueAt) return null;
    const result = await checkForNewerClaim(pr);
    // A lapse must be retried at the next boundary. Before a pass or ledger
    // write, the separate fresh guards still apply.
    if (result === null) dueAt = startedAt + TAKEOVER_POLL_MS;
    return result === "unread" ? null : result;
  };
}
