/** The difference between two shortlists: positions added, removed and moved, and lane shares changed. */
import type { RankerOutput } from "../../../../shared/priorities/ranker.ts";

export interface ShortlistDiff {
  unchanged: boolean;
  added: { key: string; position: number; lane: string; reason: string }[];
  removed: { key: string; position: number; lane: string }[];
  moved: { key: string; from: number; to: number; lane?: string }[];
  shares: { lane: string; from: number; to: number }[];
}

/** How `proposed` differs from `current`, by scope and key. */
export function shortlistDiff(
  current: RankerOutput,
  proposed: RankerOutput,
): ShortlistDiff {
  const id = (p: { scope: string; key: string }) => `${p.scope}#${p.key}`;
  const before = new Map(current.shortlist.map((p) => [id(p), p]));
  const after = new Map(proposed.shortlist.map((p) => [id(p), p]));
  const added: ShortlistDiff["added"] = [];
  const moved: ShortlistDiff["moved"] = [];
  for (const [key, p] of after) {
    const was = before.get(key);
    if (was === undefined)
      added.push({
        key: p.key,
        position: p.position,
        lane: p.lane,
        reason: p.reason,
      });
    else if (was.position !== p.position || was.lane !== p.lane)
      moved.push({
        key: p.key,
        from: was.position,
        to: p.position,
        ...(was.lane === p.lane ? {} : { lane: `${was.lane} -> ${p.lane}` }),
      });
  }
  const removed = [...before]
    .filter(([key]) => !after.has(key))
    .map(([, p]) => ({ key: p.key, position: p.position, lane: p.lane }));
  const shareOf = new Map(current.lanes.map((l) => [l.lane, l.share]));
  const shares = proposed.lanes
    .filter((l) => shareOf.get(l.lane) !== l.share)
    .map((l) => ({
      lane: l.lane,
      from: shareOf.get(l.lane) ?? 0,
      to: l.share,
    }));
  return {
    unchanged:
      added.length + removed.length + moved.length + shares.length === 0,
    added,
    removed,
    moved,
    shares,
  };
}
