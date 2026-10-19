#!/usr/bin/env bun
/**
 * Turn-budget guard: an agent-runtime hook, run before every tool call, that
 * warns the agent before the runtime's turn cap aborts the session.
 *
 * The problem. An agent runtime caps the agentic turns (API round-trips) one
 * prompt may take, and a session that reaches the cap is aborted at once:
 * mid-action, with no handoff written and no summary produced. An unattended
 * loop that dies there leaves its successor nothing. The runtime does not warn
 * first, so this hook counts the turns itself and hands the agent a wrap-up
 * instruction while turns remain to write a handoff with.
 *
 * What it counts. The session transcript (JSON Lines) holds one `assistant`
 * record per content block, and every block of one round-trip carries the
 * same `requestId`, so the count is the distinct request ids since the last
 * prompt: a `user` record that carries `promptSource`, which a tool result
 * (`toolUseResult`) and a compaction summary (`isCompactSummary`) do not. The
 * count is an approximation, biased early on purpose: a compaction or a resume
 * replays earlier records, which the id set absorbs, but a resume that also
 * resets the runtime's own counter is not visible here. Leave headroom: the
 * count is an estimate, not the runtime's own counter.
 *
 * Cost. The hook runs before every tool call and a long session's transcript
 * is tens of megabytes, so it never reads the whole file again: per-session
 * state under the temporary directory keeps a byte offset and the ids seen,
 * and each call reads only the bytes appended since the last one, plus a
 * checkpoint of at most CHECKPOINT_WINDOWS windows of CHECKPOINT_BYTES spread
 * evenly over the consumed prefix (its first and last bytes included). The
 * offset is reused only for the same file (its inode) that grew since the
 * last call and still holds the checkpointed bytes where they were. A call
 * that finds the file at the size and modification time it last read reads
 * nothing; one that finds the same size with a new modification time, a
 * smaller file, another file or a changed checkpoint was rewritten or
 * replaced, and rescans from the start. The runtime only appends to a
 * transcript, so a rewrite is the defensive case; one that grows the file and
 * keeps every checkpointed byte in place reads as an append, the price of a
 * bounded read per call. A final line without its newline is the runtime
 * mid-write; it stays unconsumed and is read whole next
 * time. Each line is read with a real JSON parser, so a tool result that
 * quotes transcript text, or a nested field that happens to be named
 * `requestId`, is never taken for a record of its own.
 *
 * Concurrency. Parallel tool calls in one turn run parallel copies of this
 * hook on one session. The state is one JSON document written through a
 * rename, and every copy recomputes from the offset it read plus the whole
 * delta, with the ids deduplicated, so the copies converge on one state
 * without a lock; the worst case is the same warning handed over twice in one
 * turn.
 *
 * Outcomes. Clear is silence. A warning is context handed to the agent
 * (`hookSpecificOutput.additionalContext`), never a denial: blocking a tool
 * call because the budget is low would cause the very abort it prevents.
 * Could not check (a payload it cannot read, a transcript it cannot read or
 * whose records it does not recognise, a complete record it cannot parse,
 * state it cannot write, a knob that is not a whole number) lets the tool call
 * through, exits 1 and says why on standard error, which the runtime shows as
 * a hook error: a guard that is silent when broken reads as checked and clear.
 * A record it cannot parse leaves the count short, so it is reported once per
 * call that reads one, and a warning due on that call names it instead. Out of scope, and silent: a subagent's
 * tool call (the payload carries `agent_id`; the parent's own transcript
 * tracks the parent's cap) and a budget set to 0.
 *
 * Knobs (environment):
 *   JIG_TURN_BUDGET            the cap to protect against; default 1000, 0 off
 *                              (the other knobs are then not read)
 *   JIG_TURN_BUDGET_MARGIN     turns before the cap at which to warn; default 50
 *   JIG_TURN_BUDGET_REFIRE     warn again every N turns; unset or 0: once more
 *                              when half the margin remains, then never
 *   JIG_TURN_BUDGET_STATE_DIR  where per-session state lives; default
 *                              <tmpdir>/jig-turn-budget
 *
 * Registered in hooks.json beside this file; tested in __tests__/.
 */
import { renameWithRetry } from "../shared/rename-with-retry.ts";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMapping as isRecord } from "../shared/config-layers.ts";

export interface State {
  /** Bytes of the transcript consumed so far. */
  offset: number;
  /** Distinct request ids since the last prompt. */
  count: number;
  /**
   * 0: no warning yet; n + 1: last warned at count n (so a warning at count
   * zero differs from none); budget + 1: both default warnings given.
   */
  fired: number;
  ids: string[];
  /** Complete records consumed since the last prompt (or the start). */
  records: number;
  /** Why the last complete line that was not JSON could not be read. */
  unreadable: string | null;
  /** Lines that were not JSON and are not reported yet. */
  unreported: number;
  /**
   * Assistant records in a row, since the last one with a request id this
   * guard reads (or the last prompt), that carry none.
   */
  stalled: number;
  /** The unsupported format is reported for this prompt already. */
  warnedUnsupported: boolean;
  /** The transcript file the offset belongs to. */
  inode: number;
  /** The transcript's size in bytes when it was last read. */
  size: number;
  /** Its modification time then, in nanoseconds, as a decimal string. */
  mtime: string;
  /** The hash of the consumed prefix's checkpoint (see checkpointRanges). */
  digest: string;
}

export interface Thresholds {
  budget: number;
  margin: number;
  /** Undefined: the default interval (once more when half the margin remains). */
  refire?: number;
}

const DEFAULT_BUDGET = 1000;
const DEFAULT_MARGIN = 50;
/**
 * Complete records since the last prompt (or the start) after which a
 * transcript that yielded no round-trip in them is reported as a format this
 * guard does not read. A prompt is answered within its first few records, so
 * a real transcript never reaches this count uncounted.
 */
export const UNSUPPORTED_AFTER = 50;
/**
 * Assistant records in a row without a request id this guard reads after
 * which the format is reported as unsupported, however many round-trips were
 * counted before them: every assistant record of a transcript this guard
 * reads carries one, so a run of them is a format change part-way through,
 * which would otherwise hold the count where it stopped.
 */
export const STALLED_AFTER = 10;
/** How many windows of the consumed prefix the checkpoint reads, at most. */
export const CHECKPOINT_WINDOWS = 16;
/** How many bytes each checkpoint window reads. */
export const CHECKPOINT_BYTES = 64;

const SESSION_ID = /^[A-Za-z0-9._-]+$/;
const NEWLINE = 10;

/** The outcome that lets the tool call through and is reported on standard error. */
export class CouldNotCheck extends Error {}

function couldNotCheck(reason: string): never {
  throw new CouldNotCheck(reason);
}

export function freshState(): State {
  return {
    offset: 0,
    count: 0,
    fired: 0,
    ids: [],
    records: 0,
    unreadable: null,
    unreported: 0,
    stalled: 0,
    warnedUnsupported: false,
    inode: 0,
    size: 0,
    mtime: "",
    digest: "",
  };
}

const whole = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;
const strings = (value: unknown): boolean =>
  Array.isArray(value) && value.every((id) => typeof id === "string");
const reason = (value: unknown): boolean =>
  value === null || typeof value === "string";
const flag = (value: unknown): boolean => typeof value === "boolean";
const isString = (value: unknown): boolean => typeof value === "string";

/** Each field of a stored state and the check its value must pass. */
const SHAPE: [keyof State, (value: unknown) => boolean][] = [
  ["offset", whole],
  ["count", whole],
  ["fired", whole],
  ["ids", strings],
  ["records", whole],
  ["unreadable", reason],
  ["unreported", whole],
  ["stalled", whole],
  ["warnedUnsupported", flag],
  ["inode", whole],
  ["size", whole],
  ["mtime", isString],
  ["digest", isString],
];

function isState(value: unknown): value is State {
  return isRecord(value) && SHAPE.every(([key, ok]) => ok(value[key]));
}

export type Kind =
  | { id: string }
  | "prompt"
  | "unrecognised"
  | { unreadable: string }
  | undefined;

/**
 * What one complete line is: a round-trip (its request id), a prompt, an
 * assistant record without a request id this guard reads, a line that is not
 * JSON (with the parser's reason), or none of these. A record of any of these
 * kinds carries one of the three strings, so a line without all of them is
 * skipped unparsed; the parser, not the substring, decides.
 */
export function classify(line: string): Kind {
  if (
    !line.includes('"requestId"') &&
    !line.includes('"promptSource"') &&
    !line.includes('"assistant"')
  )
    return undefined;
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch (error) {
    return { unreadable: message(error) };
  }
  if (!isRecord(record)) return undefined;
  const { type, requestId } = record;
  if (type === "assistant" && typeof requestId === "string" && requestId !== "")
    return { id: requestId };
  if (type === "assistant") return "unrecognised";
  if (type === "user" && "promptSource" in record) return "prompt";
  return undefined;
}

/**
 * Consume the complete lines of a delta: count each new request id of an
 * assistant record, restart the count at a prompt, and leave a final line
 * without its newline for the next call.
 */
export function scan(delta: Uint8Array, state: State): State {
  const end = delta.lastIndexOf(NEWLINE);
  if (end < 0) return state;
  const consumed = end + 1;
  const text = new TextDecoder().decode(delta.subarray(0, consumed));
  const ids = new Set(state.ids);
  let {
    count,
    fired,
    records,
    unreadable,
    unreported,
    stalled,
    warnedUnsupported,
  } = state;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    records++;
    const kind = classify(line);
    if (kind === undefined) continue;
    if (typeof kind === "object" && "unreadable" in kind) {
      unreadable = kind.unreadable;
      unreported++;
      continue;
    }
    if (kind === "unrecognised") {
      stalled++;
      continue;
    }
    stalled = 0;
    if (kind === "prompt") {
      // The runtime restarts its own counter at a prompt, so everything
      // counted so far, the id set included, is discarded.
      ids.clear();
      count = 0;
      fired = 0;
      records = 0;
      warnedUnsupported = false;
    } else if (!ids.has(kind.id)) {
      ids.add(kind.id);
      count++;
    }
  }
  return {
    ...state,
    offset: state.offset + consumed,
    count,
    fired,
    ids: [...ids],
    records,
    unreadable,
    unreported,
    stalled,
    warnedUnsupported,
  };
}

/**
 * The `fired` value to store when a warning is due now, or undefined when the
 * call stays quiet. The default interval warns at most twice: on the first
 * call inside the margin, then on the first call after half the margin
 * remains. An explicit interval warns every that many turns from the first
 * warning on, past the cap included.
 */
export function decide(state: State, t: Thresholds): number | undefined {
  const { count, fired } = state;
  if (t.budget - count > t.margin) return undefined;
  if (t.refire === undefined) {
    if (fired > t.budget) return undefined;
    if (fired === 0) return count + 1;
    const half = Math.max(1, Math.floor(t.margin / 2));
    if (count >= fired && count >= t.budget - half) return t.budget + 1;
    return undefined;
  }
  if (fired !== 0 && count < fired + t.refire - 1) return undefined;
  return count + 1;
}

/** A path as one POSIX shell word. */
export function shellWord(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

function warning(count: number, budget: number, unreadable?: string): string {
  const remaining = budget - count;
  const urgency =
    remaining <= 0
      ? "The cap is reached or passed: the next round-trip may be the one that aborts the session."
      : `About ${remaining} agentic turns remain before the runtime aborts this session mid-action.`;
  const driveState = join(
    import.meta.dir,
    "..",
    "skills",
    "drive-pr",
    "scripts",
    "drive-state.ts",
  );
  const handoff = existsSync(driveState)
    ? `Under /jig:drive-pr that is \`bun ${shellWord(driveState)} handoff <PR>\`, whose file is the successor's only resumption point; otherwise a short note where the successor session reads first.`
    : "A short note where the successor session reads first.";
  return [
    `TURN BUDGET: about ${count} of ${budget} agentic turns used. ${urgency}`,
    "The abort is hard: no handoff is written, no summary is produced, and what this session holds in memory is lost.",
    "Wrap up now rather than starting new work:",
    "  1. Finish only the step already in flight (a push mid-sequence, a reply already promised).",
    `  2. Write the handoff. ${handoff}`,
    "  3. Report what is done, what remains and the decisions taken, and end the turn.",
    "The count is an estimate from the transcript (distinct API round-trips since the last prompt), not the runtime's own counter: leave headroom.",
    ...(unreadable === undefined
      ? []
      : [`The count may be low: ${unreadable}.`]),
  ].join("\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function knob(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value))
    couldNotCheck(`${name} is not a whole number: ${JSON.stringify(raw)}`);
  return value;
}

/** The knobs, or undefined when the guard is switched off. */
function thresholds(): Thresholds | undefined {
  const budget = knob("JIG_TURN_BUDGET", DEFAULT_BUDGET);
  if (budget === 0) return undefined;
  const margin = knob("JIG_TURN_BUDGET_MARGIN", DEFAULT_MARGIN);
  const refire = knob("JIG_TURN_BUDGET_REFIRE", 0);
  return refire ? { budget, margin, refire } : { budget, margin };
}

export interface Call {
  transcript: string;
  session: string;
  event: string;
}

/** The runtime's payload read as a call, or undefined for a subagent's call (out of scope). */
export function parseCall(payload: unknown): Call | undefined {
  if (!isRecord(payload)) couldNotCheck("the payload is not a JSON object");
  const { agent_id, transcript_path, session_id, hook_event_name } = payload;
  if (typeof agent_id === "string" && agent_id !== "") return undefined;
  if (typeof transcript_path !== "string" || transcript_path === "")
    couldNotCheck("the payload names no transcript_path");
  const usable =
    typeof session_id === "string" &&
    session_id !== "." &&
    session_id !== ".." &&
    SESSION_ID.test(session_id);
  if (!usable)
    couldNotCheck(
      "the payload's session_id is missing or not usable as a directory name",
    );
  const event =
    typeof hook_event_name === "string" && hook_event_name !== ""
      ? hook_event_name
      : "PreToolUse";
  return { transcript: transcript_path, session: session_id, event };
}

function readCall(): Call | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    couldNotCheck(
      `the payload on standard input is not JSON (${message(error)})`,
    );
  }
  return parseCall(payload);
}

function stateFileFor(session: string): string {
  const directory = join(
    process.env.JIG_TURN_BUDGET_STATE_DIR || join(tmpdir(), "jig-turn-budget"),
    session,
  );
  try {
    mkdirSync(directory, { recursive: true });
  } catch (error) {
    couldNotCheck(
      `cannot create the state directory ${directory} (${message(error)})`,
    );
  }
  return join(directory, "state.json");
}

function loadState(file: string): State {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return freshState();
  }
  return isState(parsed) ? parsed : freshState();
}

function saveState(file: string, state: State): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(state));
    renameWithRetry(temporary, file);
  } catch (error) {
    couldNotCheck(`cannot write the state file ${file} (${message(error)})`);
  }
}

function readAt(fd: number, start: number, end: number): Uint8Array {
  const buffer = new Uint8Array(Math.max(0, end - start));
  let got = 0;
  while (got < buffer.length) {
    const n = readSync(fd, buffer, got, buffer.length - got, start + got);
    if (n <= 0) break;
    got += n;
  }
  return buffer.subarray(0, got);
}

/**
 * The byte ranges of a consumed prefix the checkpoint reads: the whole prefix
 * while it fits in the windows, otherwise CHECKPOINT_WINDOWS windows spread
 * evenly from its first byte to its last.
 */
export function checkpointRanges(offset: number): [number, number][] {
  if (offset <= CHECKPOINT_WINDOWS * CHECKPOINT_BYTES) return [[0, offset]];
  const last = offset - CHECKPOINT_BYTES;
  return Array.from({ length: CHECKPOINT_WINDOWS }, (_, i) => {
    const start = Math.floor((i * last) / (CHECKPOINT_WINDOWS - 1));
    return [start, start + CHECKPOINT_BYTES];
  });
}

/** The hash of the checkpointed bytes of the first `offset` bytes. */
function checkpoint(fd: number, offset: number): string {
  const parts = checkpointRanges(offset).map(([start, end]) =>
    readAt(fd, start, end),
  );
  return `${offset}:${Bun.hash(Buffer.concat(parts))}`;
}

/**
 * The state after the transcript's new bytes, or undefined when nothing
 * changed since the last call. A transcript that is another file, did not
 * grow yet was modified, or no longer holds the checkpointed bytes was
 * replaced or rewritten, so the count starts over from its first byte.
 */
function advance(transcript: string, state: State): State | undefined {
  const unreadable = (error: unknown): never =>
    couldNotCheck(
      `cannot read the transcript ${transcript} (${message(error)})`,
    );
  try {
    const stat = statSync(transcript, { bigint: true });
    const inode = Number(stat.ino);
    const size = Number(stat.size);
    const mtime = String(stat.mtimeNs);
    if (state.inode === inode && state.size === size && state.mtime === mtime)
      return undefined;
    const fd = openSync(transcript, "r");
    try {
      const same =
        state.inode === inode &&
        size > state.size &&
        checkpoint(fd, state.offset) === state.digest;
      const base = same ? state : { ...freshState(), inode };
      const scanned =
        size === base.offset ? base : scan(readAt(fd, base.offset, size), base);
      return {
        ...scanned,
        size,
        mtime,
        digest: checkpoint(fd, scanned.offset),
      };
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof CouldNotCheck) throw error;
    return unreadable(error);
  }
}

export interface Outcome {
  state: State;
  /** A warning is due: `state.fired` records it. */
  warn: boolean;
  /**
   * What to report: the transcript is not in a format this guard reads (once
   * per prompt), or lines that are not JSON left the count short.
   */
  report: "unsupported" | "unreadable" | undefined;
}

/** What a scanned state means: the state to keep, and what to tell whom. */
export function settle(state: State, t: Thresholds): Outcome {
  // The count already made is a lower bound, so an unsupported format adds its
  // notice to a warning that count makes due rather than replacing it.
  const foreign =
    (state.count === 0 && state.records >= UNSUPPORTED_AFTER) ||
    state.stalled >= STALLED_AFTER;
  const kept = foreign
    ? { ...state, unreported: 0, warnedUnsupported: true }
    : { ...state, unreported: 0 };
  const report = foreign
    ? state.warnedUnsupported
      ? undefined
      : "unsupported"
    : state.unreported > 0
      ? "unreadable"
      : undefined;
  const fired = decide(state, t);
  if (fired === undefined) return { state: kept, warn: false, report };
  return { state: { ...kept, fired }, warn: true, report };
}

function unsupported(state: State, transcript: string): string {
  const reason =
    state.unreadable === null
      ? ""
      : `; the last line that is not JSON: ${state.unreadable}`;
  const found =
    state.count === 0 && state.records >= UNSUPPORTED_AFTER
      ? `no round-trip recognised in the ${state.records} records of ${transcript} since the last prompt`
      : `${state.stalled} assistant records in a row in ${transcript} carry no request id this guard reads, after ${state.count} round-trip(s) counted since the last prompt`;
  return `${found}${reason}: this transcript is not in the format this guard reads, so the turn cap of this session is not guarded`;
}

function unreadableLines(state: State, transcript: string): string {
  return `${state.unreported} line(s) of ${transcript} that look like records are not JSON (the last: ${state.unreadable}), so the turn count leaves them out`;
}

function main(): void {
  const t = thresholds();
  if (t === undefined) return;
  const call = readCall();
  if (call === undefined) return;
  const stateFile = stateFileFor(call.session);
  const scanned = advance(call.transcript, loadState(stateFile));
  if (scanned === undefined) return;
  const { state, warn, report } = settle(scanned, t);
  saveState(stateFile, state);
  const problem =
    report === "unsupported"
      ? unsupported(scanned, call.transcript)
      : report === "unreadable"
        ? unreadableLines(scanned, call.transcript)
        : undefined;
  if (warn)
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: call.event,
          additionalContext: warning(state.count, t.budget, problem),
        },
      })}\n`,
    );
  else if (problem !== undefined) couldNotCheck(problem);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof CouldNotCheck)) throw error;
    process.stderr.write(
      `turn-budget guard: could not check — ${error.message}\n`,
    );
    process.exitCode = 1;
  }
}
