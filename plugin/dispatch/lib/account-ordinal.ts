/** Launch progress kept in launch records, so pruning old records cannot restart a weighted turn. */
import type { LaunchRecord, ReadRecord } from "./launches.ts";

type AccountIdentity = { vendor: string; configDir: string };
const identity = (account: AccountIdentity) =>
  JSON.stringify([account.vendor, account.configDir]);

/** Latest ordinal per stable account identity, or retained count for records from an older plugin. */
function accountLaunchOrdinals(
  records: readonly ReadRecord[],
): Map<string, number> {
  const counts = new Map<string, number>();
  const ordinals = new Map<string, number>();
  for (const { record } of records) {
    const key = identity(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (record.accountLaunchOrdinal !== undefined)
      ordinals.set(
        key,
        Math.max(ordinals.get(key) ?? 0, record.accountLaunchOrdinal),
      );
  }
  return new Map(
    [...counts].map(([key, count]) => [key, ordinals.get(key) ?? count]),
  );
}

/** The progress of one account; a rename does not reset its identity. */
export function accountLaunchOrdinal(
  records: readonly ReadRecord[],
  account: AccountIdentity,
): number {
  return accountLaunchOrdinals(records).get(identity(account)) ?? 0;
}

/** Only eligible accounts contribute to the position, so an unavailable account leaves its share to the others. */
export function cohortLaunchOrdinal(
  records: readonly ReadRecord[],
  accounts: readonly AccountIdentity[],
): number {
  const ordinals = accountLaunchOrdinals(records);
  return accounts.reduce(
    (sum, account) => sum + (ordinals.get(identity(account)) ?? 0),
    0,
  );
}

/** Keep the greatest ordinal's record per account while older launch records are collected. */
export function ordinalAnchors(records: readonly ReadRecord[]): Set<string> {
  const anchors = new Map<string, LaunchRecord>();
  for (const { record } of records) {
    if (record.accountLaunchOrdinal === undefined) continue;
    const key = identity(record);
    if (
      record.accountLaunchOrdinal >
      (anchors.get(key)?.accountLaunchOrdinal ?? -1)
    )
      anchors.set(key, record);
  }
  return new Set([...anchors.values()].map((record) => record.id));
}
