/** Convert a complete cached population, or a failed read, into an explicit footprint. */
import type { OutboundFailure } from "../../../../../shared/outbound/failure.ts";
import { currentMs } from "../../../../../shared/time.ts";
import { selectFootprint } from "../../../../../shared/footprint.ts";
import type {
  FootprintCacheEntry,
  FootprintItem,
  FootprintReading,
  FootprintReadOptions,
} from "./footprint-port.ts";

function labelAreas(
  item: FootprintItem,
  labels: FootprintReadOptions["areaLabels"],
): string[] {
  const present = new Set(item.labels.map((label) => label.toLowerCase()));
  return Object.entries(labels ?? {}).flatMap(([area, names]) =>
    names.some((name) => present.has(name.toLowerCase())) ? [area] : [],
  );
}

function prediction(
  item: FootprintItem,
  entry: FootprintCacheEntry | undefined,
  options: FootprintReadOptions,
  failed: boolean,
) {
  const record = selectFootprint(
    item.key,
    entry?.comments ?? [],
    item.activePickup,
  );
  if (record !== null)
    return {
      source: record.source,
      paths: record.paths,
      areas: record.areas,
      record,
    };
  const areas =
    failed && entry === undefined ? [] : labelAreas(item, options.areaLabels);
  return {
    source: areas.length ? ("labels" as const) : ("unknown" as const),
    paths: [],
    areas,
    record: null,
  };
}

export function footprintReading(
  item: FootprintItem,
  entry: FootprintCacheEntry | undefined,
  options: FootprintReadOptions,
  reason?: string,
  failure?: OutboundFailure,
): FootprintReading {
  const result: FootprintReading = {
    key: item.key,
    ...prediction(item, entry, options, reason !== undefined),
    readAt: entry?.readAt ?? null,
    ageMs: entry === undefined ? null : Math.max(0, currentMs() - entry.readAt),
    stale: reason !== undefined,
  };
  if (reason !== undefined) result.reason = reason;
  if (failure !== undefined) result.failure = failure;
  return result;
}
