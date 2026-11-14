/**
 * The record envelope: the fields every record Jig keeps carries, whatever
 * its medium, and the one codec that writes and reads them.
 *
 * Jig's components share what they know through records: a drive's state
 * on the machine, its mailbox in the working tree, its ledger on the pull
 * request, the dispatcher's launch records, a merge's follow-up marker
 * ([plugin/RECORDS.md](../../RECORDS.md) lists them). A record that carries
 * the envelope says what it is and who wrote it in the same fields
 * everywhere:
 *
 * - `kind`: its name in the records registry (`registry.ts`);
 * - `v`: the version of its kind's schema it was written in, an integer;
 * - `key`: what it is about, unique within its kind (on the forge and the
 *   tracker, within its repository), in the shape its kind declares;
 * - `writer`: who wrote it (`writer.ts`);
 * - `at`: when, as an ISO 8601 time;
 * - `generation`: for a record rewritten in place, optionally, one past the
 *   highest the writer had read.
 *
 * The envelope's fields sit beside the payload's at the top level of one
 * JSON object, so a reader written before a record carried the envelope
 * still finds the fields it reads there.
 *
 * One codec serves every medium. `encode` writes the JSON a file holds;
 * `encodeMarker` places the same bytes inside a hidden HTML-comment marker
 * on the forge:
 *
 *   <!-- <marker>
 *   {"kind":"…","v":1,"key":"…",…}
 *   -->
 *
 * Every `<` and `>` in the JSON is written as a Unicode escape, which JSON
 * allows inside a string and which leaves nothing that could close the
 * comment early.
 *
 * A reader returns an `Outcome`
 * ([ADR-0012](../../../docs/adr/ADR-0012-failures-as-values.md)) and never
 * throws on what it reads. The envelope passes a strict form: the kind is
 * registered and carries the envelope, the version is a positive integer no
 * newer than the kind's current one, the key matches the kind's key shape,
 * the writer names a host, and the time is an ISO 8601 time. The payload is
 * data: its kind's reader checks it against the kind's shape, and nothing
 * reads a field of it as an act or a command, so no record makes its reader
 * run, fetch or follow what it names. A writer that breaks the strict form
 * is a defect, and `encode` throws.
 */
import { Defect } from "../errors.ts";
import { isRecord } from "../guards.ts";
import { attempt, type Failure, failed, ok, type Outcome } from "../outcome.ts";
import { type RecordKind, recordKind } from "./registry.ts";
import { readWriter, type Writer } from "./writer.ts";
import { isoFromMs, parseMs } from "../time.ts";

export interface Envelope {
  kind: string;
  v: number;
  key: string;
  writer: Writer;
  at: string;
  generation?: number;
}

/** The envelope's fields: a payload never carries one of these names. */
const ENVELOPE_FIELDS = [
  "kind",
  "v",
  "key",
  "writer",
  "at",
  "generation",
] as const;

/** A record read back: its envelope, and the rest of its fields as its payload. */
export interface Enveloped {
  envelope: Envelope;
  payload: Record<string, unknown>;
}

/** Why a record does not read. */
export type ReadCode =
  | "not-json"
  | "not-object"
  | "no-envelope"
  | "unregistered-kind"
  | "unexpected-kind"
  | "unenveloped-kind"
  | "bad-version"
  | "newer-version"
  | "bad-key"
  | "bad-writer"
  | "bad-time"
  | "bad-generation"
  | "no-marker";

const ISO_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** A real calendar day and time: no February 30, no 24:00. */
function validTime(at: string): boolean {
  return (
    ISO_TIME.test(at) &&
    Number.isFinite(parseMs(at)) &&
    Number(at.slice(11, 13)) < 24 &&
    isoFromMs(parseMs(`${at.slice(0, 10)}T00:00:00Z`)).slice(0, 10) ===
      at.slice(0, 10)
  );
}

/** A hidden marker's name: lowercase words joined by `-`, in `:`-separated parts. */
const MARKER_NAME = /^[a-z][a-z0-9-]*(?::[a-z0-9-]+)*$/;

const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** A registered kind whose records carry the envelope. */
type EnvelopedKind = RecordKind & { key: RegExp };

const shown = (value: unknown): string => JSON.stringify(value) ?? "(none)";

/** The registered kind a record names, when the caller may read it. */
function kindOf(
  kind: unknown,
  expected: string | undefined,
): Outcome<EnvelopedKind, ReadCode> {
  const registered = typeof kind === "string" ? recordKind(kind) : undefined;
  if (registered === undefined)
    return failed(
      "unregistered-kind",
      `kind ${shown(kind)} is not in the records registry`,
    );
  if (expected !== undefined && registered.name !== expected)
    return failed(
      "unexpected-kind",
      `the record is a ${registered.name} record, not a ${expected} record`,
    );
  return registered.key === undefined
    ? failed(
        "unenveloped-kind",
        `a ${registered.name} record does not carry the envelope`,
      )
    : ok({ ...registered, key: registered.key });
}

/** Why a version is not one `kind` reads, or `null`. */
function versionFault(v: unknown, kind: RecordKind): Failure<ReadCode> | null {
  if (!isCount(v) || v < 1)
    return {
      code: "bad-version",
      reason: `version ${shown(v)} is not a positive integer`,
    };
  return v > kind.version
    ? {
        code: "newer-version",
        reason: `${kind.name} version ${v} is newer than ${kind.version}, the newest this version of Jig reads`,
      }
    : null;
}

/** Why the envelope's key, time or generation breaks the strict form, or `null`. */
function fieldFault(
  fields: Record<string, unknown>,
  kind: EnvelopedKind,
): Failure<ReadCode> | null {
  const { key, at, generation } = fields;
  if (typeof key !== "string" || !kind.key.test(key))
    return {
      code: "bad-key",
      reason: `key ${shown(key)} is not a ${kind.name} key`,
    };
  if (typeof at !== "string" || !validTime(at))
    return {
      code: "bad-time",
      reason: `the time ${shown(at)} is not an ISO 8601 time`,
    };
  return generation === undefined || isCount(generation)
    ? null
    : {
        code: "bad-generation",
        reason: `generation ${shown(generation)} is not a count`,
      };
}

/**
 * The envelope of a record already parsed from JSON, checked against the
 * strict form, and its payload; or why it does not read. `expected` is the
 * kind the caller reads: a record of another kind does not read as one.
 */
export function readEnvelope(
  value: unknown,
  expected?: string,
): Outcome<Enveloped, ReadCode> {
  if (!isRecord(value))
    return failed("not-object", "the record is not a JSON object");
  if (!("kind" in value))
    return failed("no-envelope", "the record carries no envelope");
  const kind = kindOf(value.kind, expected);
  if (!kind.ok) return kind;
  const { kind: _kind, v, key, writer, at, generation, ...payload } = value;
  const fault = versionFault(v, kind.value) ?? fieldFault(value, kind.value);
  if (fault !== null) return { ok: false, failure: fault };
  const by = readWriter(writer);
  if (by === null)
    return failed("bad-writer", "the writer does not name a host");
  return ok({
    envelope: {
      kind: kind.value.name,
      v: v as number,
      key: key as string,
      writer: by,
      at: at as string,
      ...(generation === undefined ? {} : { generation: generation as number }),
    },
    payload,
  });
}

/** JSON text with every `<` and `>` escaped, so it cannot close an HTML comment. */
export function commentSafe(json: string): string {
  return json.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/**
 * The JSON text of a record: the envelope's fields first, then the
 * payload's. Throws a `Defect` when the envelope breaks the strict
 * form or the payload carries one of the envelope's field names, so a
 * writer never writes what a reader refuses.
 */
export function encode(
  envelope: Envelope,
  payload: Record<string, unknown>,
): string {
  const clash = ENVELOPE_FIELDS.find((field) => field in payload);
  if (clash !== undefined)
    throw new Defect(
      `the payload of a ${envelope.kind} record carries the envelope's field ${clash}`,
    );
  const { kind, v, key, writer, at, generation } = envelope;
  const json = JSON.stringify({
    kind,
    v,
    key,
    writer,
    at,
    ...(generation === undefined ? {} : { generation }),
    ...payload,
  });
  const checked = readEnvelope(JSON.parse(json), kind);
  if (!checked.ok)
    throw new Defect(
      `a ${kind} record breaks the envelope's strict form: ${checked.failure.reason}`,
    );
  return commentSafe(json);
}

/** A record read from its JSON text, or why it does not read. */
export function decode(
  text: string,
  expected?: string,
): Outcome<Enveloped, ReadCode> {
  const parsed = attempt(
    "not-json",
    "the record is not JSON",
    () => JSON.parse(text) as unknown,
  );
  return parsed.ok ? readEnvelope(parsed.value, expected) : parsed;
}

/** The record's JSON inside the hidden marker `marker`, as it goes on the forge. */
export function encodeMarker(
  marker: string,
  envelope: Envelope,
  payload: Record<string, unknown>,
): string {
  if (!MARKER_NAME.test(marker))
    throw new Defect(`${JSON.stringify(marker)} is not a marker name`);
  return `<!-- ${marker}\n${encode(envelope, payload)}\n-->`;
}

/** The text between `<!-- <marker>` and its closing `-->` in `body`, or why there is none. */
export function markerText(
  body: string,
  marker: string,
): Outcome<string, "no-marker"> {
  const text = body.replaceAll("\r", "");
  const open = `<!-- ${marker}\n`;
  const start = text.indexOf(open);
  if (start === -1) return failed("no-marker", `there is no ${marker} marker`);
  const end = text.indexOf("\n-->", start + open.length);
  if (end === -1)
    return failed("no-marker", `the ${marker} marker is not closed`);
  return ok(text.slice(start + open.length, end));
}

/** The record inside the hidden marker `marker` in `body`, or why it does not read. */
export function decodeMarker(
  body: string,
  marker: string,
  expected?: string,
): Outcome<Enveloped, ReadCode> {
  const text = markerText(body, marker);
  return text.ok ? decode(text.value, expected) : text;
}
