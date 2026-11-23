/**
 * The copy of a run's transcript Jig keeps for a run that left no closing
 * report: the steward reads its excerpt (`transcript-excerpt.ts`) to record
 * the run's cause, and a person may read more of it than the excerpt holds.
 * The vendor's own transcript stays where the vendor writes it; Jig never
 * deletes a vendor's files and keeps no copy of a reported run's.
 *
 * A run is found in its vendor's transcripts by its session id: Claude Code
 * takes the one the tick minted (`--session-id`, the record's `sessionId`)
 * and writes `<config dir>/projects/<project>/<session>.jsonl`; Codex takes
 * none and prints the one it chose in its header or JSON startup event.
 * The wrapper keeps it on the exit (`session`). Codex writes
 * `<CODEX_HOME>/sessions/<yyyy>/<mm>/<dd>/rollout-<time>-<session>.jsonl`.
 * A Codex run that printed no session id has no transcript Jig can find.
 *
 * The copy is the end of the transcript, at most `COPY_BYTES`, each line
 * with email addresses, account identifiers, tokens and other
 * credential-shaped values, the record's own token and a provider account's
 * resolved credential replaced with `<redacted>` (a provider account's run
 * is copied only by the process that holds that credential), in
 * `<dispatch>/runs/<record>/transcript.jsonl`, beside `copy.json`, which
 * says when the copy was made, from which session, and, when there is none,
 * why. The directory and its files are readable only by
 * their owner. The copy is removed `KEPT_AFTER_CAUSE_DAYS` after the
 * steward's cause for the run is applied, and at the latest after the
 * machine file's `receipts_days`; the run's bounded output on its launch
 * record and the copy's path on its outcome row go with it.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { claudeCode } from "../../shared/agent-harness/claude-code.ts";
import { harnessOrDefault } from "../../shared/agent-harness/index.ts";
import { isMapping } from "../../shared/config-layers.ts";
import { isCredentialKey, maskCredentials } from "../../shared/credentials.ts";
import { heldCredential, holdsCredentialOf } from "./provider-held.ts";
import { OMITTED_LINE_TEXT } from "./provider-credential.ts";
import { swallow } from "../../shared/errors.ts";
import { redactStrings } from "../../shared/redact.ts";
import { LAUNCH_RECORD_ID } from "../../shared/records/launch-claims.ts";
import { currentIso, parseMs } from "../../shared/time.ts";
import {
  forEachDirEntry,
  readBoundedTail,
} from "../../skills/drive-pr/scripts/lib/quota/types.ts";
import { storedEndedRow } from "./closing-report-store.ts";
import type { LaunchRecord } from "./launches.ts";
import { stateRoot } from "../receipts.ts";
import { stateDb } from "./state.ts";

/** The most of a transcript's end the copy keeps. */
export const COPY_BYTES = 2 * 1024 * 1024;
/** How long a copy stays once the steward's cause for its run is applied, leaving a person time to look. */
const KEPT_AFTER_CAUSE_DAYS = 7;
/** The effect a steward's `cause` record has once the tick applied it. */
export const CAUSE_RECORDED = "recorded";

const DAY_MS = 86_400_000;
/** The most expired run directories one tick removes. */
const PRUNE_ENTRIES = 1000;
const SESSION =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** What `copy.json` says of one run's copy. */
export interface TranscriptCopy {
  version: 1;
  record: string;
  /** When the copy was made, or found impossible. */
  at: string;
  /** The vendor session id the transcript was looked for under; `null` when the run has none. */
  session: string | null;
  /** The copy's path; `null` when there is none. */
  transcript: string | null;
  /** Why there is no copy; absent when there is one. */
  missing?: string;
  /** Whether the copy leaves anything of the transcript out: the start of one longer than the copy keeps, or a line (marked where it stood) that did not read or still matched a held secret. */
  cut: boolean;
}

/** The directory of one run's copy. */
export function runDir(root: string, id: string): string {
  return join(root, "runs", id);
}

/** Read the session ID from a Codex text header or JSON startup event. */
export { codexSessionIn } from "../../shared/agent-harness/codex.ts";

/** Claude Code's transcript of `session` under `configDir`, in any project. */
export function claudeTranscript(
  configDir: string,
  session: string,
): string | null {
  return claudeCode.transcript({
    configDir,
    session,
    startedMs: 0,
    walk: forEachDirEntry,
  });
}

/** The vendor transcript of a run under `session`, or why there is none. */
function findTranscript(
  record: Pick<LaunchRecord, "vendor" | "configDir" | "createdAt">,
  session: string | null,
): { path: string } | { missing: string } {
  const harness = harnessOrDefault(record.vendor);
  if (session === null)
    return {
      missing:
        harness.capabilities.sessionId === "printed"
          ? `the ${harness.label} pass printed no session id`
          : "the run has no session id",
    };
  // Claude Code mints UUIDs; another harness prints its own shape, so only a path-safe id is required of it.
  if (
    !(harness.name === claudeCode.name ? SESSION : SAFE_SESSION).test(session)
  )
    return { missing: "the run's session id is not one" };
  const path = harness.transcript({
    configDir: record.configDir,
    session,
    startedMs: parseMs(record.createdAt),
    walk: forEachDirEntry,
  });
  return path === null
    ? { missing: "the vendor's transcript of the session was not found" }
    : { path };
}

/** Mask secret fields before string redaction loses their key context. */
function maskFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskFields);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        isCredentialKey(key) ? "<redacted>" : maskFields(field),
      ]),
    );
  return value;
}

/** `text` with every one of `secrets` replaced, the longest first so one that contains another goes whole. */
function replaceSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("<redacted>");
  return out;
}

/** The deepest nesting of JSON encoded inside strings that is looked into; anything deeper counts as holding a secret. */
const LOOK_DEPTH = 8;

/** The JSON a string holds as a whole, or after a header line, or as a quoted JSON string; `undefined` when it holds none. */
function embeddedJson(text: string): unknown {
  const start = text.search(/[[{"]/);
  // Ordinary prose rarely ends where JSON does, so most text never reaches the parser.
  if (start === -1 || !/[\]}"]\s*$/.test(text)) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    // Only a fixed diagnostic: the parser's own message can quote the text.
    swallow(new SyntaxError("not JSON"), "a string that is not JSON is text");
    return undefined;
  }
}

const escapedForms = new Map<string, string>();

/** `secret` as `JSON.stringify` writes it inside a string, computed once per secret. */
function escapedForm(secret: string): string {
  let form = escapedForms.get(secret);
  if (form === undefined) {
    form = JSON.stringify(secret).slice(1, -1);
    escapedForms.set(secret, form);
  }
  return form;
}

const ESCAPE = /\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g;
/** The same escape, for testing without the global flag's state. */
const DECODABLE_ESCAPE = new RegExp(ESCAPE.source);

/** Whether `text`, with JSON escapes of any spelling decoded up to `LOOK_DEPTH` times, holds one of `secrets`: wrapped JSON that does not parse as a whole is still looked into. */
function holdsAfterUnescaping(
  text: string,
  secrets: readonly string[],
): boolean {
  // A canonically escaped credential is found at any offset, whatever surrounds it and however the surrounding backslashes would pair when decoding.
  if (secrets.some((secret) => text.includes(escapedForm(secret)))) return true;
  let layer = text;
  for (let i = 0; i <= LOOK_DEPTH; i++) {
    if (secrets.some((secret) => layer.includes(secret))) return true;
    if (!layer.includes("\\")) return false;
    const next = layer.replace(
      ESCAPE,
      (_all, hex: string | undefined, plain: string | undefined) =>
        hex !== undefined
          ? String.fromCharCode(Number.parseInt(hex, 16))
          : ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" }[plain as string] ??
            (plain as string)),
    );
    if (next === layer) return false;
    layer = next;
  }
  // Decoded as deep as is looked into: the last layer is searched for each secret, and counts as holding one only while it still holds a decodable escape, unless nothing but literal backslashes is left.
  return (
    secrets.some((secret) => layer.includes(secret)) ||
    (DECODABLE_ESCAPE.test(layer) && !/^\\+$/.test(layer))
  );
}

/** The deepest structural nesting of arrays and objects that is walked; anything deeper counts as holding a secret. */
const NEST_LIMIT = 64;

/** Whether `value`, or any JSON a string in it encodes at any depth, still holds a secret or a credential field that is not masked. Nothing is rewritten: a hit leaves the whole line out, so no number or property name is ever re-encoded. */
function leaksDecoded(
  value: unknown,
  secrets: readonly string[],
  depth: number,
  decoded: boolean,
  nest = 0,
): boolean {
  if (depth > LOOK_DEPTH || nest > NEST_LIMIT) return true;
  if (typeof value === "string") {
    // A fenced block, a header or trailing text around encoded JSON does not parse, so the text is unescaped, in any spelling, and searched for each secret.
    if (holdsAfterUnescaping(value, secrets)) return true;
    const inner = embeddedJson(value);
    return inner !== undefined && leaksDecoded(inner, secrets, depth + 1, true);
  }
  if (typeof value === "number")
    return secrets.some((secret) => String(value).includes(secret));
  if (Array.isArray(value))
    return value.some((item) =>
      leaksDecoded(item, secrets, depth, decoded, nest + 1),
    );
  if (value !== null && typeof value === "object")
    return Object.entries(value).some(
      ([key, field]) =>
        leaksDecoded(key, secrets, depth, decoded, nest + 1) ||
        (decoded &&
          isCredentialKey(key) &&
          field !== "<redacted>" &&
          field !== "" &&
          field !== null) ||
        leaksDecoded(field, secrets, depth, decoded, nest + 1),
    );
  return false;
}

/** `value` with each exact secret replaced in every string, every number written as one and every property name, before any generic redaction can split it. JSON a string encodes is not decoded here: `leaksDecoded` leaves such a line out when it holds a secret. */
function maskExact(value: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === "string") return replaceSecrets(value, secrets);
  if (typeof value === "number") {
    const written = String(value);
    return replaceSecrets(written, secrets) === written ? value : "<redacted>";
  }
  if (Array.isArray(value))
    return value.map((item) => maskExact(item, secrets));
  if (value !== null && typeof value === "object") {
    const rebuilt: Record<string, unknown> = Object.create(null);
    for (const [key, field] of Object.entries(value)) {
      let name = replaceSecrets(key, secrets);
      // Two names that mask alike stay two fields; only names already written count.
      for (let n = 2; name in rebuilt; n++)
        name = `${replaceSecrets(key, secrets)}#${n}`;
      rebuilt[name] = maskExact(field, secrets);
    }
    return rebuilt;
  }
  return value;
}

/** The line that stands where one or more lines were left out, so a reader knows evidence is missing there. */
export const OMITTED_LINE = OMITTED_LINE_TEXT;

/** The transcript's lines, each redacted; a line that does not read as JSON, or that would still match a held secret, is left out and a marker line stands in its place. `kept` counts the lines that are not markers. */
function redactedLines(
  text: string,
  held: readonly string[],
): { lines: string[]; kept: number; omitted: number } {
  const secrets = [...new Set(held.filter((secret) => secret !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  const mask = (value: string) =>
    maskCredentials(replaceSecrets(value, secrets), "<redacted>");
  const lines: string[] = [];
  let omitted = 0;
  const leaveOut = () => {
    omitted++;
    if (lines[lines.length - 1] !== OMITTED_LINE) lines.push(OMITTED_LINE);
  };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // The parser's message can quote the line's text, which may be a credential: nothing of it is logged.
      leaveOut();
      continue;
    }
    // A source record shaped like the marker could not be told from one Jig wrote.
    if (isMapping(value) && value.type === "jig-omitted") {
      leaveOut();
      continue;
    }
    let serialized: string;
    let residual: boolean;
    try {
      // The exact values are masked structurally in the parsed strings, numbers and property names, so no generic rule can split them.
      const masked = redactStrings(maskExact(maskFields(value), secrets), mask);
      serialized = JSON.stringify(masked);
      // A match left in the serialized line, or in JSON a string encodes, is never edited: the line is left out. A value too deep to walk is left out too.
      residual =
        secrets.some((secret) =>
          [secret, JSON.stringify(secret).slice(1, -1)].some((form) =>
            serialized.includes(form),
          ),
        ) || leaksDecoded(masked, secrets, 0, false);
    } catch {
      // A stack overflow on a deeply nested value: nothing of its message is logged.
      leaveOut();
      continue;
    }
    if (residual) {
      leaveOut();
      continue;
    }
    lines.push(serialized);
  }
  return {
    lines,
    kept: lines.filter((l) => l !== OMITTED_LINE).length,
    omitted,
  };
}

/** The end of `lines` that fits in `COPY_BYTES`, and whether any was left out. */
function boundedEnd(lines: string[]): { text: string; dropped: boolean } {
  let size = 0;
  let from = lines.length;
  while (from > 0) {
    const next = Buffer.byteLength(lines[from - 1] as string) + 1;
    if (size + next > COPY_BYTES) break;
    size += next;
    from--;
  }
  const kept = lines.slice(from);
  return {
    text: kept.length === 0 ? "" : `${kept.join("\n")}\n`,
    dropped: from > 0,
  };
}

/** Write `body` to `path` through a temporary file, readable only by its owner. */
function writePrivate(path: string, body: string): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, body, { mode: 0o600 });
  renameSync(temporary, path);
}

/**
 * Copy the end of the run's transcript under `session` into its run
 * directory, redacted, and write `copy.json` either way; the copy it wrote,
 * or `null` when nothing could be written. An earlier copy stands.
 */
export function keepTranscriptCopy(
  record: Pick<
    LaunchRecord,
    "id" | "token" | "vendor" | "configDir" | "createdAt" | "provider"
  >,
  session: string | null,
  root = stateRoot(),
): TranscriptCopy | null {
  if (!LAUNCH_RECORD_ID.test(record.id)) return null;
  const earlier = readTranscriptCopy(record.id, root);
  if (earlier !== null) return earlier;
  const dir = runDir(root, record.id);
  try {
    mkdirSync(join(root, "runs"), { recursive: true, mode: 0o700 });
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // A provider account's transcript may hold its key, which only the process that resolved it can mask.
    const found =
      record.provider !== undefined && !holdsCredentialOf(record)
        ? {
            missing:
              "a provider account's transcript is copied only by the wrapper that holds its credential",
          }
        : findTranscript(record, session);
    let copy: TranscriptCopy = {
      version: 1,
      record: record.id,
      at: currentIso(),
      session,
      transcript: null,
      cut: false,
    };
    if ("missing" in found) copy = { ...copy, missing: found.missing };
    else {
      const longer = statSync(found.path).size > COPY_BYTES;
      const redacted = redactedLines(readBoundedTail(found.path, COPY_BYTES), [
        record.token,
        heldCredential(record.id) ?? "",
      ]);
      const { text, dropped } = boundedEnd(redacted.lines);
      // Whether the bounded copy still holds evidence is judged after the bound, over the lines that survived it.
      const surviving = text
        .split("\n")
        .filter((l) => l !== "" && l !== OMITTED_LINE).length;
      if (surviving === 0 && (longer || redacted.omitted > 0 || dropped))
        copy = {
          ...copy,
          missing: "no line of the transcript could be kept safely",
          cut: true,
        };
      else {
        const path = join(dir, "transcript.jsonl");
        writePrivate(path, text);
        copy = {
          ...copy,
          transcript: path,
          cut: longer || dropped || redacted.omitted > 0,
        };
      }
    }
    writePrivate(join(dir, "copy.json"), `${JSON.stringify(copy)}\n`);
    return copy;
  } catch (error) {
    swallow(error, "the run's transcript could not be copied");
    return null;
  }
}

function isCopy(value: unknown): value is TranscriptCopy {
  return (
    isMapping(value) &&
    value.version === 1 &&
    typeof value.record === "string" &&
    typeof value.at === "string" &&
    (value.session === null || typeof value.session === "string") &&
    (value.transcript === null || typeof value.transcript === "string") &&
    typeof value.cut === "boolean"
  );
}

/** What `copy.json` of run `id` says; `null` when the run has none, or it does not read. */
export function readTranscriptCopy(
  id: string,
  root = stateRoot(),
): TranscriptCopy | null {
  if (!LAUNCH_RECORD_ID.test(id)) return null;
  const path = join(runDir(root, id), "copy.json");
  if (!existsSync(path)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isCopy(value) && value.record === id ? value : null;
  } catch (error) {
    swallow(error, "a transcript copy's description does not read");
    return null;
  }
}

/** The copied transcript's text; `null` when there is none, or it does not read. */
export function copiedTranscript(copy: TranscriptCopy): string | null {
  if (copy.transcript === null) return null;
  try {
    return readFileSync(copy.transcript, "utf8");
  } catch (error) {
    swallow(error, "a transcript copy does not read");
    return null;
  }
}

/** When the steward's cause for each run was applied, by its launch record. */
function causesApplied(root: string): Map<string, number> {
  const rows = stateDb(root)
    .query(
      "SELECT json_extract(value, '$.record') AS record, effect_at_ms AS at FROM steward_records WHERE effect = ? AND json_valid(value) AND json_extract(value, '$.kind') = 'cause'",
    )
    .all(CAUSE_RECORDED) as Array<{ record: unknown; at: number | null }>;
  const applied = new Map<string, number>();
  for (const row of rows)
    if (typeof row.record === "string" && typeof row.at === "number")
      applied.set(row.record, row.at);
  return applied;
}

/** The run's bounded output and its outcome row's path to the copy go with the copy. */
function forgetCopy(root: string, id: string): void {
  const db = stateDb(root);
  db.query(
    "UPDATE launches SET exit = json_remove(exit, '$.context') WHERE id = ? AND json_valid(exit) AND json_type(exit, '$.context') IS NOT NULL",
  ).run(id);
  const row = storedEndedRow(db, id);
  if (row === null || !("transcript" in row)) return;
  delete row.transcript;
  db.query(
    "UPDATE log SET seq = (SELECT MAX(seq) + 1 FROM log), row = ? WHERE key = ?",
  ).run(JSON.stringify(row), `ended ${id}`);
}

/** Whether a run's copy is due for removal at `nowMs`. */
function copyDue(
  root: string,
  id: string,
  nowMs: number,
  days: number,
  applied: Map<string, number>,
): boolean {
  const causeAt = applied.get(id);
  if (
    causeAt !== undefined &&
    nowMs - causeAt >= KEPT_AFTER_CAUSE_DAYS * DAY_MS
  )
    return true;
  const copy = readTranscriptCopy(id, root);
  const at =
    copy === null ? statSync(runDir(root, id)).mtimeMs : parseMs(copy.at);
  return !Number.isFinite(at) || nowMs - at >= days * DAY_MS;
}

/**
 * Remove each run's copy that is due: `KEPT_AFTER_CAUSE_DAYS` after the
 * steward's cause for it was applied, and at the latest `days` after it was
 * made. Returns the runs whose copy went.
 */
export function pruneTranscriptCopies(
  nowMs: number,
  days: number,
  root = stateRoot(),
): string[] {
  const runs = join(root, "runs");
  if (!existsSync(runs)) return [];
  const removed: string[] = [];
  try {
    const applied = causesApplied(root);
    forEachDirEntry(runs, (entry) => {
      const id = entry.name;
      if (!entry.isDirectory() || !LAUNCH_RECORD_ID.test(id)) return true;
      if (!copyDue(root, id, nowMs, days, applied)) return true;
      rmSync(runDir(root, id), { recursive: true, force: true });
      forgetCopy(root, id);
      removed.push(id);
      return removed.length < PRUNE_ENTRIES;
    });
  } catch (error) {
    swallow(error, "the transcript copies could not all be pruned");
  }
  return removed;
}
