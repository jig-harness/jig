/** The ledger shape this version reads and writes: the envelope's `v`, and `ledgerVersion` beside it. */
export const LEDGER_VERSION = 3;
/** What an ordinary ledger is written at, so hosts that predate the managed-user grammar still read it; a managed recipient raises it on render. */
export const OPERATOR_STOP_LEDGER_VERSION = 2;

/** A stored `ledgerVersion` newer than this version reads. */
export function isFutureVersion(version: unknown): version is number {
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version > LEDGER_VERSION
  );
}

/** Whether a stored `ledgerVersion` is one this version reads. */
export function isReadableVersion(version: unknown): boolean {
  return (
    version === 1 ||
    version === OPERATOR_STOP_LEDGER_VERSION ||
    version === LEDGER_VERSION
  );
}

/** The lowest ledger version that carries what a ledger holds: a managed recipient needs the newest, an operator stop the one before. */
export function writtenVersion(ledger: {
  ledgerVersion: number;
  parked: readonly { person?: string | null }[];
  driver: { personStop?: unknown };
}): number {
  if (ledger.parked.some((park) => park.person?.includes("_") === true))
    return LEDGER_VERSION;
  if (ledger.driver.personStop === undefined) return ledger.ledgerVersion;
  return Math.max(ledger.ledgerVersion, OPERATOR_STOP_LEDGER_VERSION);
}
