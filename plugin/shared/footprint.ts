/** Predicted repository paths, carried in a trusted tracker comment. */
import { decodeMarker, encodeMarker } from "./records/envelope.ts";
import type { Writer } from "./records/writer-shape.ts";
import { matches, s } from "./shapes.ts";
import { parseMs } from "./time.ts";
import { OutboundError } from "./outbound/failure.ts";

const FOOTPRINT_MARKER = "jig:footprint";
export const FOOTPRINT_SHAPE = s.object({
  source: s.enum(["pickup", "scout", "planner", "filing"]),
  base: s.string({ pattern: "^[0-9a-f]{7,64}$" }),
  paths: s.array(s.string({ minLength: 1, maxLength: 1024 }), {
    maxItems: 1000,
  }),
  areas: s.array(
    s.string({ pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", maxLength: 100 }),
    { maxItems: 100 },
  ),
  pickup: s.optional(s.string({ minLength: 1, maxLength: 200 })),
});
export interface FootprintRecord {
  key: string;
  writer: Writer;
  at: string;
  source: "pickup" | "scout" | "planner" | "filing";
  base: string;
  paths: string[];
  areas: string[];
  /** The claiming session; the caller supplies it only while that claim has a running session. */
  pickup?: string | undefined;
}

function validPath(path: string): boolean {
  return (
    !Array.from(path).some(
      (c) =>
        c.charCodeAt(0) < 32 ||
        c.charCodeAt(0) === 127 ||
        "\\:*?[]{}".includes(c),
    ) &&
    !path.startsWith("/") &&
    path
      .replace(/\/$/, "")
      .split("/")
      .every((p) => p !== "" && p !== "." && p !== "..")
  );
}
function payloadOf(record: FootprintRecord) {
  return {
    source: record.source,
    base: record.base,
    paths: record.paths,
    areas: record.areas,
    ...(record.pickup === undefined ? {} : { pickup: record.pickup }),
  };
}

/** Render through the envelope codec, which escapes marker delimiters in data. */
export function footprintBody(record: FootprintRecord): string {
  const payload = payloadOf(record);
  if (!matches(FOOTPRINT_SHAPE, payload) || !record.paths.every(validPath))
    throw new OutboundError("invalid", "invalid tracker footprint payload");
  return `${encodeMarker(FOOTPRINT_MARKER, { kind: "tracker-footprint", v: 1, key: record.key, writer: record.writer, at: record.at }, payload)}\nPredicted footprint (${record.source}, at ${record.base}): ${record.paths.length} paths; areas: ${record.areas.join(", ") || "none"}.\n`;
}

/** Trust is checked by the selector; a marker alone proves no authority. */
export function readFootprint(
  body: string,
  key: string,
): FootprintRecord | null {
  if (!body.includes(`<!-- ${FOOTPRINT_MARKER}`)) return null;
  const read = decodeMarker(body, FOOTPRINT_MARKER, "tracker-footprint");
  if (!read.ok || read.value.envelope.key !== key) return null;
  const p = read.value.payload;
  if (!matches(FOOTPRINT_SHAPE, p) || !p.paths.every(validPath)) return null;
  const { writer, at } = read.value.envelope;
  return {
    key,
    writer,
    at,
    source: p.source,
    base: p.base,
    paths: p.paths,
    areas: p.areas,
    ...(p.pickup === undefined ? {} : { pickup: p.pickup }),
  };
}

/** Newest within a live pickup first, otherwise newest across all predictions. */
export function selectFootprint(
  key: string,
  comments: readonly { body: string; trusted: boolean }[],
  activePickup?: string,
): FootprintRecord | null {
  const records = [...comments]
    .reverse()
    .flatMap((c) => {
      const record = c.trusted ? readFootprint(c.body, key) : null;
      return record === null ? [] : [record];
    })
    .sort((a, b) => parseMs(b.at) - parseMs(a.at));
  return (
    records.find(
      (r) =>
        activePickup !== undefined &&
        r.source === "pickup" &&
        r.pickup === activePickup,
    ) ??
    records[0] ??
    null
  );
}
