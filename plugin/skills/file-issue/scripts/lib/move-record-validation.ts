/** Validate nested migration data before it can drive tracker writes. */
import { isRecord } from "../../../../shared/guards.ts";
import { parseFacetEntries } from "../../../do-item/scripts/lib/tracker/facets/config.ts";
import { FACETS } from "../../../do-item/scripts/lib/tracker/port.ts";
import { MoveRecordError } from "./move-error.ts";
import { parseMs } from "../../../../shared/time.ts";

const nonempty = (v: unknown): v is string =>
  typeof v === "string" && v.trim() !== "";
const facet = (v: unknown) => (FACETS as readonly unknown[]).includes(v);
const date = (v: unknown) =>
  typeof v === "string" && Number.isFinite(parseMs(v));
function value(v: unknown, f: string): boolean {
  if (v === null) return true;
  if (!nonempty(v)) return false;
  return f !== "priority" || ["urgent", "high", "medium", "low"].includes(v);
}
function labels(v: unknown): boolean {
  return (
    v === undefined ||
    (Array.isArray(v) && v.every(nonempty) && new Set(v).size === v.length)
  );
}
function require(ok: boolean, path: string, why: string): void {
  if (!ok) throw new MoveRecordError(`${path} is not a move record: ${why}`);
}

function sections(
  r: Record<string, unknown>,
  moved: unknown[],
  path: string,
): void {
  require(moved.length > 0 &&
    new Set(moved).size ===
      moved.length, path, "empty or duplicate moved facets");
  try {
    parseFacetEntries(r.source, String(r.adapter));
    parseFacetEntries(r.target, String(r.adapter));
    // sidesOf compares moved with the resolved stores using the repository's taxonomy.
  } catch (err) {
    throw new MoveRecordError(
      `${path}: invalid source/target or moved facets (${err instanceof Error ? err.message : "invalid"})`,
      { cause: err },
    );
  }
}

function store(
  entry: unknown,
  moved: unknown[],
  seen: Set<string>,
  path: string,
): void {
  require(isRecord(entry), path, "invalid store change");
  const s = entry as Record<string, unknown>;
  const key = `${s.side} ${s.facet}`;
  require(facet(s.facet) &&
    moved.includes(s.facet) &&
    !seen.has(key), path, "invalid or duplicate store facet");
  seen.add(key);
  require(["source", "destination"].includes(String(s.side)) &&
    ["label", "native", "field"].includes(
      String(s.store),
    ), path, "invalid store kind or side");
  require(value(s.before, String(s.facet)) &&
    value(s.after, String(s.facet)), path, "invalid facet value");
  require(s.store !== "field" ||
    nonempty(s.field), path, "field store without field");
  require(labels(s.labelsAdded) &&
    labels(s.labelsRemoved), path, "invalid label delta");
}

function change(entry: unknown, moved: unknown[], path: string): void {
  require(isRecord(entry), path, "invalid change");
  const c = entry as Record<string, unknown>;
  require(nonempty(c.issue) &&
    ["copy", "retire", "restore"].includes(
      String(c.phase),
    ), path, "invalid change identity");
  require(date(c.at) &&
    typeof c.done === "boolean", path, "invalid change time or status");
  require(Array.isArray(c.stores) &&
    c.stores.length > 0, path, "no store changes");
  const seen = new Set<string>();
  for (const s of c.stores as unknown[]) store(s, moved, seen, path);
}

export function validateRecordContents(
  r: Record<string, unknown>,
  path: string,
): void {
  const moved = r.moved as unknown[];
  sections(r, moved, path);
  require(date(r.previewedAt), path, "invalid preview time");
  for (const [key, snapshot] of Object.entries(
    r.snapshots as Record<string, unknown>,
  )) {
    require(nonempty(key) && isRecord(snapshot), path, "invalid snapshot");
    require(Object.entries(snapshot as object).every(
      ([f, v]) => facet(f) && moved.includes(f) && value(v, f),
    ), path, "invalid snapshot facet/value");
  }
  for (const c of r.changes as unknown[]) change(c, moved, path);
}
