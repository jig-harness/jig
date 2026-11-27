import { readConfig } from "../../../../../shared/consumer.ts";
import { currentMs } from "../../../../../shared/time.ts";
import {
  optionalPollPacing,
  readStatusPolling,
} from "../status/poll-pacing.ts";
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

async function checkForNewerClaim(
  pr: string,
  readSnapshot = readLedgerSnapshot,
): Promise<number | null | "unread"> {
  const driver = ledgerDriverFromEnv();
  if (driver === null || driver.floor === null) return "unread";
  const snapshot = await readSnapshot(pr, driver.login);
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
  deferPoll = optionalPollPacing(
    readStatusPolling(readConfig()),
    "drive takeover",
  ),
): () => Promise<number | null> {
  let dueAt = Number.NEGATIVE_INFINITY;
  let lastReadAt: number | undefined;
  return async () => {
    const startedAt = now();
    if (startedAt < dueAt) return null;
    if (lastReadAt !== undefined && deferPoll(lastReadAt, TAKEOVER_POLL_MS))
      return null;
    const wallStartedAt = currentMs();
    const result = await checkForNewerClaim(pr, readCompleteLedgerSnapshot);
    // A lapse must be retried at the next boundary. Before a pass or ledger
    // write, the separate fresh guards still apply.
    lastReadAt = result === null ? wallStartedAt : undefined;
    dueAt =
      result === null ? startedAt + TAKEOVER_POLL_MS : Number.NEGATIVE_INFINITY;
    return result === "unread" ? null : result;
  };
}
