/** Serialize local ledger payload construction through verified forge publication. */
import { createLock, lockHeartbeatMs } from "./lock.ts";

export async function withLedgerWriteLock<T>(
  stateDir: string,
  pr: string,
  write: () => Promise<T>,
): Promise<T> {
  using lock = createLock(
    stateDir,
    `ledger-mirror-${BigInt(pr).toString()}`,
    "ledger",
    pr,
  );
  await lock.acquire();
  const heartbeat = setInterval(() => lock.touch(), lockHeartbeatMs());
  try {
    return await write();
  } finally {
    clearInterval(heartbeat);
  }
}
