/** Derive the unreleased pickup records that still hold each item. */
import type { LaunchRecord, ReadRecord } from "./launches.ts";

/** Whether a pickup record still holds `item`: not released whole, nor released for this member alone. */
export function holdsItem(
  record: Pick<LaunchRecord, "released" | "releasedItems">,
  item: string,
): boolean {
  return !record.released && !(record.releasedItems?.includes(item) ?? false);
}

/** The latest unreleased pickup record for every item it owns. */
export function latestPickups(records: ReadRecord[]): Set<string> {
  const latest = new Map<string, ReadRecord>();
  for (const read of records) {
    const { record } = read;
    if (record.action !== "pickup" || record.released) continue;
    const members = record.batchItems?.map((item) => item.key) ?? [record.item];
    for (const member of members) {
      if (member === null || !holdsItem(record, member)) continue;
      const key = `${record.repo}\0${member}`;
      const seen = latest.get(key);
      if (seen === undefined || record.createdAt >= seen.record.createdAt)
        latest.set(key, read);
    }
  }
  return new Set([...latest.values()].map(({ record }) => record.id));
}
