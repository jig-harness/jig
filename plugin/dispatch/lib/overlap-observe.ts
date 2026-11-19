/**
 * What overlap reads in a repository's observe phase: the footprints of the
 * pickups the tick wants and of the claimed items in flight, through the
 * tracker port the tick already opened (`TrackerFootprints.footprints`),
 * and the change-area catalog serialization read.
 *
 * The footprint read is the tracker's governed transport
 * (design/overlap-aware-admission.md § Reading it): an item's comments are
 * kept, in memory, under the tracker the tick opened, until its `updatedAt`
 * moves; the wanted pickups are read first; at most `MAX_FRESH` items are
 * read fresh in one tick, each read under the tick's deadline and recorded
 * in the cost ledger under `footprint`. A footprint that does not read
 * keeps its last reading with its age; one never read is unknown, with the
 * failure class as its reason. Nothing is read when no pickup is wanted.
 *
 * A claimed item's pickup record stands while this host's launch record of
 * it holds and names its session (`activePickup`); for another host's
 * pickup the newest record stands.
 */
import { loadCatalogText } from "../../skills/drive-pr/scripts/lib/change-areas-catalog.ts";
import type { ChangeAreaCatalog } from "../../skills/drive-pr/scripts/lib/change-areas-catalog.ts";
import type {
  FootprintCacheEntry,
  FootprintItem,
  FootprintReading,
} from "../../skills/do-item/scripts/lib/tracker/footprint-port.ts";
import type { Tracker } from "../../skills/do-item/scripts/lib/tracker/port.ts";
import { attempt } from "../../shared/outcome.ts";
import { isoFromMs } from "../../shared/time.ts";
import { holds, type ReadRecord } from "./launches.ts";
import type { TickBound } from "./sources/bounded.ts";
import { failureText } from "./text.ts";
import type { ClaimedItem, WantedItem } from "./types.ts";

/** The most items whose footprints one repository's tick reads fresh. */
export const MAX_FRESH = 20;

/** A tick does not see the tracker's full-read generation; items whose comments do not move `updatedAt` are re-read once per window, not once per tick. */
const SCOPE_WINDOW_MS = 15 * 60_000;

/** What overlap read in the observe phase, for the plan phase. */
export interface OverlapFacts {
  /** Each item's footprint, by key; an item absent was not read. */
  readings: ReadonlyMap<string, FootprintReading>;
  /** The catalog, where it was read and is valid; `null` otherwise. */
  catalog: ChangeAreaCatalog | null;
  /** Facts read short: why the catalog or the footprints are missing. */
  notes: string[];
}

/** The per-tracker cache, which lives as long as the tracker the tick opened. */
const caches = new WeakMap<object, Map<string, FootprintCacheEntry>>();

function cacheOf(tracker: object): Map<string, FootprintCacheEntry> {
  let cache = caches.get(tracker);
  if (cache === undefined) {
    cache = new Map();
    caches.set(tracker, cache);
  }
  return cache;
}

/** The catalog serialization read, parsed; a note when it does not read. */
function catalogOf(
  text: string | null | undefined,
  where: string,
): { catalog: ChangeAreaCatalog | null; note: string | null } {
  if (text === undefined) return { catalog: null, note: null };
  if (text === null)
    return {
      catalog: null,
      note: `the change-area catalog is missing from the default branch, so area labels give no footprint and no path is generated`,
    };
  const parsed = attempt("invalid", "the change-area catalog", () =>
    loadCatalogText(text, where),
  );
  return parsed.ok
    ? { catalog: parsed.value, note: null }
    : {
        catalog: null,
        note: `${parsed.failure.reason}, so area labels give no footprint and no path is generated`,
      };
}

/** Labels the item carries, where the tracker's read took them. */
function labelsOf(item: { queueIssue?: { labels: string[] } }): string[] {
  return item.queueIssue?.labels ?? [];
}

/** The session of this host's launch record that holds `key` with a session, when there is one. */
function activeSession(
  key: string,
  records: readonly ReadRecord[],
): string | undefined {
  const holding = records.find(
    (r) =>
      r.record.action === "pickup" &&
      r.record.item === key &&
      r.state.kind === "alive" &&
      typeof r.record.sessionId === "string" &&
      r.record.sessionId !== "",
  );
  return holding?.record.sessionId ?? undefined;
}

export interface OverlapObserveInput {
  tracker: Tracker | null;
  wanted: readonly WantedItem[];
  claimed: readonly ClaimedItem[] | null;
  /** This host's launch records. */
  records: readonly ReadRecord[];
  catalogText: string | null | undefined;
  /** Where the catalog was read, for its error. */
  where: string;
  nowMs: number;
  bound?: TickBound | undefined;
}

/** The footprint items in read order: the wanted pickups first, then the claimed items. */
export function footprintItems(input: OverlapObserveInput): FootprintItem[] {
  const seen = new Set<string>();
  const out: FootprintItem[] = [];
  const add = (item: {
    key: string;
    updatedAt?: string;
    queueIssue?: { labels: string[] };
  }) => {
    if (seen.has(item.key)) return;
    seen.add(item.key);
    const active = activeSession(item.key, input.records);
    out.push({
      key: item.key,
      labels: labelsOf(item),
      ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
      ...(active === undefined ? {} : { activePickup: active }),
    });
  };
  for (const w of input.wanted) add(w);
  for (const c of input.claimed ?? [])
    add(c as ClaimedItem & { queueIssue?: { labels: string[] } });
  // A pickup this host started and no tracker list carries yet still holds files.
  for (const r of input.records)
    if (
      r.record.action === "pickup" &&
      r.record.item !== null &&
      holds(r.state)
    )
      add({ key: r.record.item });
  return out;
}

/** Read the footprints overlap weighs; never throws, a failed read is a note and unknown footprints. */
export async function readOverlapFacts(
  input: OverlapObserveInput,
): Promise<OverlapFacts> {
  const { catalog, note } = catalogOf(input.catalogText, input.where);
  const notes = note === null ? [] : [note];
  if (input.wanted.length === 0) return { readings: new Map(), catalog, notes };
  const tracker = input.tracker;
  if (tracker === null || typeof tracker.footprints !== "function")
    return {
      readings: new Map(),
      catalog,
      notes: [
        ...notes,
        "the tracker was not opened, so every footprint is unknown",
      ],
    };
  const areaLabels = Object.fromEntries(
    [...(catalog ?? new Map())].map(([key, area]) => [key, area.labels]),
  );
  try {
    const readings = await tracker.footprints(footprintItems(input), {
      cycle: {},
      scopeRead: isoFromMs(input.nowMs - (input.nowMs % SCOPE_WINDOW_MS)),
      cache: cacheOf(tracker),
      areaLabels,
      maxFresh: MAX_FRESH,
      ...(input.bound === undefined
        ? {}
        : { deadline: input.bound.deadline, signal: input.bound.signal }),
    });
    return { readings, catalog, notes };
  } catch (error) {
    return {
      readings: new Map(),
      catalog,
      notes: [
        ...notes,
        `the footprints could not be read, so every footprint is unknown: ${failureText(error)}`,
      ],
    };
  }
}
