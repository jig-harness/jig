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
 * credential-shaped values and the record's own token replaced with
 * `<redacted>`, in `<dispatch>/runs/<record>/transcript.jsonl`, beside
 * `copy.json`, which says when the copy was made, from which session, and,
 * when there is none, why. The directory and its files are readable only by
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
  /** Whether the transcript was longer than the copy keeps. */
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

/** The transcript's lines, each redacted; a line that does not read as JSON is left out. */
function redactedLines(text: string, token: string): string[] {
  const mask = (value: string) =>
    maskCredentials(
      token === "" ? value : value.split(token).join("<redacted>"),
      "<redacted>",
    );
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      swallow(error, "a transcript line that does not read is left out");
      continue;
    }
    lines.push(JSON.stringify(redactStrings(maskFields(value), mask)));
  }
  return lines;
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
    "id" | "token" | "vendor" | "configDir" | "createdAt"
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
    const found = findTranscript(record, session);
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
      const { text, dropped } = boundedEnd(
        redactedLines(readBoundedTail(found.path, COPY_BYTES), record.token),
      );
      const path = join(dir, "transcript.jsonl");
      writePrivate(path, text);
      copy = { ...copy, transcript: path, cut: longer || dropped };
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
