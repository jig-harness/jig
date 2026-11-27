/**
 * The follow-ups a tick runs again rather than handing to a person: a
 * headless session that stopped before it could start, retried for as long as
 * it does; a pass that died during its work with no result and no question,
 * run again once while its death is recent; and a pass whose result or exit
 * the host could not write (`unwritten-result.ts`), run again once whatever
 * it said and however long ago (`retriedDeath`). The last two are the host's
 * faults: the tick releases their markers only while the host's health check
 * passes (`rerun-gate.ts`), and `failures.rerun_died: 0` turns them off.
 *
 * A startup that stopped is recognised for every stage whose Claude Code
 * session the wrapper starts (`failedStartup`), and the wrapper walls its
 * account: until the reset a usage notice states (`startupReset`), else for
 * `wall_backoff`. A failing pass of such a session that stopped on the
 * vendor's usage notice, in its output or as its transcript's last entry
 * (`usageNotice`), is read the same way however long it ran. A pickup
 * stopped by a notice is wanted again once a wall keeps it off that account
 * (`pickup-hold.ts`).
 */
import { statSync } from "node:fs";
import { harnessNamed } from "../../shared/agent-harness/index.ts";
import { basename, join } from "node:path";
import {
  forEachDirEntry,
  readBoundedTail,
} from "../../skills/drive-pr/scripts/lib/quota/types.ts";
import type { SuggestedNext } from "../../shared/closing-report.ts";
import type { LaunchAction, LaunchRecord, ReadRecord } from "./launches.ts";
import { RECOVERY_FACTS } from "./recovery-facts.ts";
import { questionOf } from "./session.ts";
import { attempt } from "../../shared/outcome.ts";
import { swallow } from "../../shared/errors.ts";
import { SESSION_LEASE_MIN } from "../../shared/liveness.ts";
import { currentMs, isoFromMs, parseMs } from "../../shared/time.ts";
import { noticeReset } from "./notice-reset.ts";
import { claudeTranscript } from "./transcript-copy.ts";
import { isMapping } from "../../shared/config-layers.ts";
import type { Wall } from "./walls.ts";

/** Startup failures are limited to the first minute of the vendor process. */
const STARTUP_MS = 60_000;

export function passedStartupWindow(started: number, exited: number): boolean {
  return exited - started > STARTUP_MS;
}

/**
 * A complete bounded scan must confirm absence. A matching filename proves
 * presence conservatively; content also catches transcripts named differently.
 * Any unreadable file or truncated scan withholds the retry.
 */
function transcriptFiles(configDir: string, deadline: number): string[] | null {
  const files: string[] = [];
  let entries = 0;
  let complete = true;
  const budget = () => {
    if (++entries > 10_000 || currentMs() >= deadline) complete = false;
    return complete;
  };
  const root = join(configDir, "projects");
  const read = forEachDirEntry(root, (entry) => {
    if (!budget()) return false;
    // A link may lead to transcripts this scan does not follow, so it cannot
    // confirm absence.
    if (entry.isSymbolicLink()) {
      complete = false;
      return false;
    }
    if (!entry.isDirectory()) return true;
    const dir = join(root, entry.name);
    if (
      !forEachDirEntry(dir, (file) => {
        if (!budget()) return false;
        if (file.name.endsWith(".jsonl")) files.push(join(dir, file.name));
        return true;
      })
    )
      complete = false;
    return complete;
  });
  return read && complete ? files : null;
}

function transcriptAbsent(record: LaunchRecord, started: number): boolean {
  const session = record.sessionId as string;
  const deadline = currentMs() + 200;
  const files = transcriptFiles(record.configDir, deadline);
  if (files === null) return false;
  try {
    for (const path of files) {
      if (currentMs() >= deadline) return false;
      if (basename(path) === `${session}.jsonl`) return false;
      if (statSync(path).mtimeMs < started) continue;
      // A large file whose beginning is outside the tail cannot prove absence.
      if (statSync(path).size > 256 * 1024) return false;
      if (readBoundedTail(path, 256 * 1024).includes(session)) return false;
    }
    return true;
  } catch (error) {
    swallow(error, "the session's transcript absence could not be confirmed");
    return false;
  }
}

/**
 * The `resets …` clause of a recognized standalone vendor notice in the
 * output, or `null` when it holds none; only such a notice is persisted,
 * never arbitrary output.
 */
function quotaNotice(output: string): string | null {
  let found: string | null = null;
  for (const line of output.split(/\r?\n/)) {
    const clause = noticeClause(line);
    if (clause !== null) found = clause;
  }
  return found;
}

/** The `resets …` clause of `line` when the line is the vendor's usage notice, else `null`. */
function noticeClause(line: string): string | null {
  const parts = line.trim().split("·");
  if (parts.length !== 2) return null;
  const reset = (parts[1] ?? "").trim();
  return /^you(?:'|’)ve hit your (?:session |weekly |usage )?limit$/i.test(
    (parts[0] ?? "").trim(),
  ) && /^resets\s+\S/i.test(reset)
    ? reset
    : null;
}

/** The text parts of an assistant entry's message, never a tool call's. */
function assistantTexts(entry: Record<string, unknown>): string[] {
  const content = isMapping(entry.message) ? entry.message.content : undefined;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) =>
    isMapping(part) && part.type === "text" && typeof part.text === "string"
      ? [part.text]
      : [],
  );
}

/** The text of a rate-limit error entry that holds one text part and no line break; `undefined` for any other entry. */
function noticeText(entry: Record<string, unknown>): string | undefined {
  if (entry.error !== "rate_limit" || entry.isApiErrorMessage !== true)
    return undefined;
  const texts = assistantTexts(entry);
  const text = texts.length === 1 ? (texts[0] ?? "").trim() : "";
  return /[\r\n]/.test(text) ? undefined : text;
}

/**
 * The usage notice a Claude Code session's transcript ends on: its last
 * assistant entry (user entries and tool output are skipped) is an entry the vendor marked as a rate-limit
 * error (`error: "rate_limit"` with `isApiErrorMessage`) whose text is the notice and nothing else;
 * ordinary model output that reads like the notice is none (`undefined`: the
 * transcript was read and rejected it); `null` when the transcript holds no
 * assistant entry to judge (no session, no file, unreadable). A notice in a user entry, in a tool's output or call, or
 * inside longer text is none. Only the notice is returned, never other
 * content.
 */
function transcriptUsageNotice(
  record: LaunchRecord,
): string | undefined | null {
  const lines = transcriptTail(
    record,
    65_536,
    "the transcript could not be read for a usage notice",
  );
  for (const line of lines.reverse()) {
    const entry = transcriptEntry(line);
    if (entry === undefined) continue;
    if (entry.type !== "assistant") continue;
    const text = noticeText(entry);
    return text !== undefined && noticeClause(text) !== null ? text : undefined;
  }
  return null;
}

/** One transcript line as an entry; a partial line, or one that is no JSON mapping, is none. */
function transcriptEntry(line: string): Record<string, unknown> | undefined {
  if (!line.startsWith("{")) return undefined;
  const entry = attempt(
    "invalid",
    "Transcript entry is not JSON",
    (): unknown => JSON.parse(line),
  );
  return entry.ok && isMapping(entry.value) ? entry.value : undefined;
}

/** The lines of the last `bytes` of a Claude Code session's transcript; none when it has no session, no transcript, or the read fails (`why`). */
function transcriptTail(
  record: LaunchRecord,
  bytes: number,
  why: string,
): string[] {
  const session = record.sessionId;
  if (session === null || session === undefined) return [];
  try {
    const path = claudeTranscript(record.configDir, session);
    if (path === null) return [];
    return readBoundedTail(path, bytes).trimEnd().split("\n");
  } catch (error) {
    swallow(error, why);
    return [];
  }
}

/**
 * The usage notice the session's transcript ends on (the vendor's own error
 * entry), else, only when no transcript could be judged, the last standalone
 * notice in the output: an earlier notice never outranks a later one, and a
 * readable transcript's verdict outranks the output.
 */
function noticeOf(record: LaunchRecord, output: string): string | undefined {
  const verified = transcriptUsageNotice(record);
  // A transcript that was read and rejected the notice is the provenance
  // check's answer: echoed or model-produced output text never overrides it.
  if (verified !== null) return verified;
  const notices = output
    .split(/\r?\n/)
    .filter((line) => noticeClause(line) !== null);
  return notices.pop()?.trim();
}

/**
 * The vendor's usage notice a failing pass of a Claude Code session the
 * wrapper started stopped on, however long it ran (`noticeOf`); `undefined`
 * when there is none, for a pass that exited cleanly, and for another
 * stage's pass.
 */
function usageNotice(
  record: LaunchRecord,
  code: number | null,
  output: string,
): string | undefined {
  if (
    !ownSession(record) ||
    harnessNamed(record.vendor)?.capabilities.signInProbe !== true ||
    code === null ||
    code === 0
  )
    return undefined;
  return noticeOf(record, output);
}

/**
 * The vendor's usage notice in a startup's output: its `resets …` clause,
 * and the reset it states at or after `nowMs` (`notice-reset.ts`), `null`
 * when that does not read; `null` when the output holds no notice.
 */
export function startupReset(
  output: string,
  nowMs: number,
): { clause: string; resetAt: string | null } | null {
  const clause = quotaNotice(output);
  if (clause === null) return null;
  const at = noticeReset(clause, Temporal.Instant.fromEpochMilliseconds(nowMs));
  return {
    clause,
    resetAt: at === null ? null : isoFromMs(at.epochMilliseconds),
  };
}

/**
 * The wall for the account of a pass that stopped on it: until the reset a
 * usage notice states, else `wall_backoff` from `nowMs`, its source saying
 * which, and naming a notice clause that did not read.
 */
export function startupWall(
  record: LaunchRecord,
  startup: string,
  output: string,
  nowMs: number,
): Wall {
  const notice =
    startup === "quota"
      ? startupReset(noticeOf(record, output) ?? "", nowMs)
      : null;
  const from =
    startup === "quota"
      ? "session stopped at its usage limit (quota)"
      : `session could not start (${startup})`;
  let source = `${from}; wall_backoff`;
  if (notice?.resetAt != null) source = `${from}; the usage notice's reset`;
  else if (notice != null)
    source = `${from}; the notice's reset did not read; wall_backoff`;
  return {
    account: record.account,
    vendor: record.vendor,
    configDir: record.configDir,
    resetAt: notice?.resetAt ?? isoFromMs(nowMs + record.wallBackoffMs),
    source,
  };
}

/**
 * The stages whose Claude Code session the wrapper starts itself, with the
 * session id the tick minted (`--session-id`): a follow-up's, a steward's
 * and a headless pickup's pass. A drive's passes are `drive.ts`'s, which
 * reads its own wall (`QUOTA_PARKED`).
 */
function ownSession(record: LaunchRecord): boolean {
  return (
    record.action === "followup" ||
    record.action === "steward" ||
    (record.action === "pickup" && record.headless === true)
  );
}

export type StartupFailure = "quota" | "unstarted" | "sign-in" | "breaker";

const SIGN_IN_PHRASES = [
  "API Error: 401",
  "Failed to authenticate",
  "OAuth session expired",
  "Please run /login",
  "Not logged in",
  "Not logged in · Please run /login",
  "Authentication required · Sign in again to continue",
] as const;
export type SignInPhrase = (typeof SIGN_IN_PHRASES)[number];

/** Keep the recognised phrase, never the rest of a vendor error. */
export function signInPhrase(text: string): SignInPhrase | undefined {
  for (const line of text.split(/\r?\n/)) {
    const message = line
      .trim()
      .replace(/^error:\s*/i, "")
      .toLowerCase();
    const phrase = SIGN_IN_PHRASES.find((candidate) => {
      const expected = candidate.toLowerCase();
      if (!message.startsWith(expected)) return false;
      const remainder = message.slice(expected.length);
      if (candidate === "API Error: 401")
        return remainder === "" || /^[\s.:]/.test(remainder);
      if (candidate === "Not logged in · Please run /login")
        return remainder === "" || /^[.:]/.test(remainder);
      return remainder === "" || /^[.:]/.test(remainder);
    });
    if (phrase !== undefined) return phrase;
  }
  return undefined;
}

/** Select content outside user entries without keeping any of it. */
function transcriptEntryParts(entry: unknown): unknown[] {
  if (!isMapping(entry) || entry.type === "user") return [];
  const content = isMapping(entry.message)
    ? entry.message.content
    : entry.content;
  return Array.isArray(content)
    ? content
    : [content, entry.error, entry.message];
}

function transcriptLineSignIn(line: string): SignInPhrase | undefined {
  if (!line.startsWith("{")) return signInPhrase(line);
  // A failed process can leave a partial entry. Its text is not diagnostic.
  const entry = attempt(
    "invalid",
    "Transcript entry is not JSON",
    (): unknown => JSON.parse(line),
  );
  if (!entry.ok) return undefined;
  for (const part of transcriptEntryParts(entry.value)) {
    const text = isMapping(part) ? part.text : part;
    if (typeof text !== "string") continue;
    const phrase = signInPhrase(text);
    if (phrase !== undefined) return phrase;
  }
  return undefined;
}

function transcriptSignIn(record: LaunchRecord): SignInPhrase | undefined {
  const lines = transcriptTail(
    record,
    16_384,
    "the startup transcript could not be read",
  );
  for (const line of lines.slice(-8).reverse()) {
    const phrase = transcriptLineSignIn(line);
    if (phrase !== undefined) return phrase;
  }
  return undefined;
}

export function quickStartupDeath(
  record: LaunchRecord,
  code: number | null,
  started: number,
  exited: number,
): boolean {
  return (
    ownSession(record) &&
    harnessNamed(record.vendor)?.capabilities.signInProbe === true &&
    typeof record.sessionId === "string" &&
    code !== null &&
    code !== 0 &&
    !passedStartupWindow(started, exited)
  );
}

/**
 * Why a failing pass of a session the wrapper started stopped on its
 * account: within the startup window, a sign-in refusal, a usage notice, or
 * an exit that left no transcript; past it, only a usage notice.
 */
export function failedStartup(
  record: LaunchRecord,
  code: number | null,
  started: number,
  output: string,
  exited: number,
  keepPhrase?: (phrase: SignInPhrase) => void,
): Exclude<StartupFailure, "breaker"> | undefined {
  if (!quickStartupDeath(record, code, started, exited))
    return usageNotice(record, code, output) === undefined
      ? undefined
      : "quota";
  if (usageNotice(record, code, output) !== undefined) return "quota";
  const phrase = signInPhrase(output) ?? transcriptSignIn(record);
  if (phrase !== undefined) {
    keepPhrase?.(phrase);
    return "sign-in";
  }
  return transcriptAbsent(record, started) ? "unstarted" : undefined;
}

/**
 * Who takes a pass that could not start on from here: the tick, once the
 * account's wall lifts or its backoff ends; except a pickup that stopped with
 * no usage notice, which no rule starts again (`pickup-hold.ts`), so a person
 * picks its item up again or releases it.
 */
export function startupNext(
  action: LaunchAction,
  startup: StartupFailure,
): SuggestedNext {
  if (startup === "sign-in" || startup === "breaker")
    return {
      step: "The dispatcher starts it again on another free account, or on this one after its backoff.",
      owner: "line",
    };
  if (action === "pickup" && startup === "unstarted")
    return {
      step: "A person picks the item up again or releases it: no rule starts a pickup that stopped at startup without a usage notice.",
      owner: "person",
      act: "Decide",
    };
  return {
    step:
      startup === "quota"
        ? action === "pickup"
          ? "The dispatcher starts it again on another account that is free, or on this one once its wall lifts."
          : "The dispatcher starts it again once the account's wall lifts."
        : "The dispatcher starts it again once the account's backoff ends.",
    owner: "line",
  };
}

/** Persisted startup evidence permits only the follow-up attempt that never began to retry. */
export function retryableStartup(r: ReadRecord): boolean {
  return (
    r.record.action === "followup" &&
    r.result === null &&
    r.state.kind === "ended" &&
    r.state.exit.startup !== undefined
  );
}

/**
 * Whether a follow-up's pass ended with no result through no fault of its
 * own: its wrapper died, or the pass ended on a signal or a failing exit, with
 * no result recorded and no question stated (in its launch record or its closing report); or, whatever its exit and its
 * question, its result or exit could not be written on the host
 * (`unwrittenResult`). One that recorded `failed`, stopped on a question, or
 * exited cleanly without a result, with everything written, is not one.
 */
export function diedWithoutResult(r: ReadRecord): boolean {
  if (r.record.action !== "followup" || r.result !== null) return false;
  if (retryableStartup(r)) return false;
  if (unwrittenResult(r)) return true;
  if (r.state.kind === "died")
    return (
      questionOf(r.state) === null && r.report?.report.question === undefined
    );
  if (r.state.kind !== "ended") return false;
  const { code, signal } = r.state.exit;
  return (
    (code !== 0 || signal !== null) &&
    questionOf(r.state) === null &&
    r.report?.report.question === undefined
  );
}

/** Whether a pass that ended has no result and the host kept evidence that its result or exit could not be written. */
export function unwrittenResult(r: ReadRecord): boolean {
  return (
    r.result === null &&
    r.unwritten !== undefined &&
    (r.state.kind === "ended" || r.state.kind === "died")
  );
}

/** Whether a follow-up is itself a run again, of one that died or that stopped on a routine question: its failure is a person's. */
export function isRerun(record: Pick<LaunchRecord, "facts">): boolean {
  return record.facts.startsWith(RECOVERY_FACTS);
}

/**
 * How long after its death a follow-up is still the tick's to run again: the
 * session lease (`SESSION_LEASE_MIN`), after which what a session held counts
 * as abandoned. A tick, which runs every few minutes, releases a death's
 * marker well inside it; an older death, a record kept from before deaths
 * were run again among them, keeps the failed follow-up's notice, since a
 * person may already have settled it.
 */
const RETRY_WITHIN_MS = SESSION_LEASE_MIN * 60_000;

/** When a follow-up's record ended: its exit's time, else when its outcome row was timed, else when it was made; `NaN` when none reads. */
function endedAtMs(r: ReadRecord): number {
  if (r.state.kind === "ended") return parseMs(r.state.exit.at);
  return parseMs(r.record.endedAt ?? r.record.createdAt);
}

/**
 * A follow-up that died during its work for the first time, within the retry
 * window, or whose result or exit the host could not write, at any age: its
 * marker is released, and it runs again once. Never one launched while
 * `failures.rerun_died` was `0`.
 */
export function retriedDeath(r: ReadRecord, nowMs = currentMs()): boolean {
  return (
    r.record.rerunDied !== 0 &&
    diedWithoutResult(r) &&
    !isRerun(r.record) &&
    (unwrittenResult(r) || nowMs - endedAtMs(r) <= RETRY_WITHIN_MS)
  );
}

/** Whether a follow-up's end is a retry rather than an outcome: a startup that never began, or a first death. */
export function retryableFollowup(r: ReadRecord): boolean {
  return retryableStartup(r) || retriedDeath(r);
}

/** The ids of retryable follow-ups whose end no later row has settled. */
export function unsettledStartups(
  records: ReadRecord[],
  settled: Set<string>,
): string[] {
  return records
    .filter((r) => retryableFollowup(r) && !settled.has(r.record.id))
    .map((r) => r.record.id);
}
