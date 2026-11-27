import { newerClaim } from "../state/ledger.ts";
import {
  readCompleteLedgerSnapshot,
  readLedgerSnapshot,
} from "../state/ledger-forge.ts";
import {
  LEDGER_DRIVER_ENV,
  ledgerDriverFromEnv,
} from "../state/ledger-mirror.ts";
import { TAKEN_OVER_EXIT } from "./settings.ts";

const TAKEOVER_POLL_MS = 60_000;

/** A listing the check could not use, and why. */
type Unread = { unread: string; expected?: boolean };

async function checkForNewerClaim(
  pr: string,
  readSnapshot = readLedgerSnapshot,
): Promise<number | null | Unread> {
  const driver = ledgerDriverFromEnv();
  if (driver === null)
    return { unread: "this driver writes no ledger", expected: true };
  if (driver.floor === null)
    return { unread: "this driver has no ledger floor", expected: true };
  const snapshot = await readSnapshot(pr, driver.login);
  if (typeof snapshot === "string") return { unread: snapshot };
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
  return typeof result === "object" && result !== null ? null : result;
}

/**
 * Pace successful round-boundary reads for this drive only. A rejected read
 * is retried at the next checkpoint, and its reason is logged once per run
 * of rejections for that reason, so a drive that keeps retrying shows why.
 */
export function roundBoundaryTakeoverCheck(
  pr: string,
  now = () => performance.now(),
): () => Promise<number | null> {
  let dueAt = Number.NEGATIVE_INFINITY;
  let rejected: string | null = null;
  return async () => {
    const startedAt = now();
    if (startedAt < dueAt) return null;
    const result = await checkForNewerClaim(pr, readCompleteLedgerSnapshot);
    if (typeof result === "object" && result !== null) {
      // A lapse must be retried at the next boundary. Before a pass or
      // ledger write, the separate fresh guards still apply.
      if (result.unread !== rejected && !result.expected)
        console.error(
          `drive.ts: the round-boundary takeover check rejected PR #${pr}'s ledger listing: ${result.unread}; it reads the listing again at each round checkpoint until one reads.`,
        );
      rejected = result.unread;
      return null;
    }
    rejected = null;
    if (result === null) dueAt = startedAt + TAKEOVER_POLL_MS;
    return result;
  };
}
