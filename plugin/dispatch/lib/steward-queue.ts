/** The steward breaks ties without overriding the queue's own precedence. */
import { compareQueue, queueHold, type QueueItem } from "./queue-rank.ts";
import type { WantedItem } from "./types.ts";
import { parseMs } from "../../shared/time.ts";

interface OrderRecord {
  kind: "order";
  targets: string[];
  reason: string;
}
type Ranked<T> = { item: T; rank: QueueItem };

/** Only tied members named by a valid record exchange their existing slots. */
export function applyStewardOrder<T extends WantedItem>(
  items: readonly T[],
  records: readonly OrderRecord[],
): T[] {
  const out = [...items];
  for (const record of records) {
    if (new Set(record.targets).size !== record.targets.length) continue;
    const ranked = record.targets.map((key) => out.find((i) => i.key === key));
    if (ranked.some((i) => i === undefined)) continue;
    for (const group of tiedGroups(ranked)) exchange(out, group);
  }
  return out;
}

function tiedGroups<T extends WantedItem>(
  items: Array<T | undefined>,
): Ranked<T>[][] {
  const groups: Ranked<T>[][] = [];
  for (const item of items) {
    if (!item) continue;
    const rank = rankOf(item);
    if (rank === null) continue;
    const group = groups.find(
      (g) => g[0] && compareQueue(g[0].rank, rank) === 0,
    );
    if (group) group.push({ item, rank });
    else groups.push([{ item, rank }]);
  }
  return groups;
}

function exchange<T>(out: T[], group: Ranked<T>[]): void {
  const members = new Set(group.map((g) => g.item));
  const slots = out.flatMap((item, index) =>
    members.has(item) ? [index] : [],
  );
  for (let n = 0; n < slots.length; n++) {
    const slot = slots[n];
    const next = group[n];
    if (slot !== undefined && next) out[slot] = next.item;
  }
}

function rankOf(item: WantedItem): QueueItem | null {
  const issue = item.queueIssue;
  const rank = item.queueRank;
  if (!issue || !rank || !Number.isFinite(parseMs(issue.createdAt)))
    return null;
  const value: QueueItem = { issue, blockers: [], ...rank };
  return queueHold(value) === null ? value : null;
}
