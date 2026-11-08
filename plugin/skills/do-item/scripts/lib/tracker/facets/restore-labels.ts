/** Exact label restoration, validated through the facet's own label codec. */
import { TrackerRequestError, type Facet, type IssuePatch } from "../port.ts";
import type { CorePoolIssue } from "./tracker.ts";
import type { LabelCodec } from "./label.ts";
import { fold } from "./values.ts";

export function validateRestore(
  codec: LabelCodec,
  labels: string[],
  expected?: string | null,
): void {
  if (
    !Array.isArray(labels) ||
    labels.some((l) => typeof l !== "string" || !codec.owns(l)) ||
    new Set(labels.map((l) => codec.read([l]))).size > 1
  )
    throw new TrackerRequestError(
      "invalid",
      `invalid ${codec.facet} labels to restore`,
    );
  if (expected !== undefined && codec.read(labels) !== expected)
    throw new TrackerRequestError(
      "invalid",
      `the ${codec.facet} assignment and exact labels disagree`,
    );
}

export function addRestores(
  changes: Array<[LabelCodec, string | null]>,
  restores: IssuePatch["facetLabels"],
  codecs: Map<Facet, LabelCodec>,
  coreFacets: ReadonlySet<Facet>,
): void {
  for (const [f, labels] of Object.entries(restores ?? {})) {
    const codec = codecs.get(f as Facet);
    if (codec === undefined) {
      if (coreFacets.has(f as Facet)) continue;
      throw new TrackerRequestError("invalid", `no label store for ${f}`);
    }
    validateRestore(codec, labels, changes.find(([c]) => c === codec)?.[1]);
    if (!changes.some(([c]) => c === codec))
      changes.push([codec, codec.read(labels)]);
  }
}

export function restoringChange(
  codec: LabelCodec,
  current: string[],
  value: string | null,
  exact: string[] | undefined,
) {
  if (exact === undefined) return codec.change(current, value);
  return {
    add: exact.filter((l) => !current.some((c) => fold(c) === fold(l))),
    remove: current.filter(
      (l) => codec.owns(l) && !exact.some((c) => fold(c) === fold(l)),
    ),
  };
}

export function forwardRestores(
  out: IssuePatch,
  codecs: Map<Facet, LabelCodec>,
): void {
  if (out.facetLabels === undefined) return;
  out.facetLabels = Object.fromEntries(
    Object.entries(out.facetLabels).filter(([f]) => !codecs.has(f as Facet)),
  );
  if (Object.keys(out.facetLabels).length === 0) delete out.facetLabels;
}

/** A census belongs to a single explicit caller token, never the long-lived tracker. */
export function censusReader(
  read: (signal?: AbortSignal) => Promise<CorePoolIssue[]>,
) {
  const censuses = new WeakMap<object, Promise<CorePoolIssue[]>>();
  return (key: object | undefined, signal?: AbortSignal) => {
    if (key === undefined) return read(signal);
    let pending = censuses.get(key);
    if (pending === undefined) {
      pending = read(signal);
      censuses.set(key, pending);
    }
    return pending;
  };
}
