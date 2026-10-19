/**
 * The worktree's journal: findings captured as they happen, before `reflect`
 * sends them to the store.
 *
 * A JSONL file git never tracks, holding finding events and two kinds of
 * line about them: `contributed` (the store has it, and where) and `dropped`
 * (kept out of the store, and why). A third, `parked`, records that a
 * worktree being removed moved the finding to the pending folder. Lines are
 * only appended. A finding noted again under its id is a revision: the last
 * one counts until the finding leaves the journal. Writing here needs no
 * network, no lock and no configuration beyond the switch, so capturing a
 * finding never fails because the store is unreachable.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  type Change,
  derivedId,
  eventProblems,
  type FindingEvent,
  jsonlLines,
  newId,
  nowAt,
  parseEvent,
  parseObject,
} from "./events.ts";
import { currentChange, pendingDir, sessionBlock } from "./context.ts";

export interface ContributedLine {
  type: "contributed";
  id: string;
  ref: string | null;
  at: string;
}

export interface DroppedLine {
  type: "dropped";
  id: string;
  reason: string;
  merged_into?: string;
  at: string;
}

export interface ParkedLine {
  type: "parked";
  id: string;
  to: string;
  at: string;
}

/**
 * One pending file's lines, adopted as a single journal line: a write cut off
 * part-way leaves a line no reader takes, so an adoption lands whole or not
 * at all.
 */
export interface AdoptedLine {
  type: "adopted";
  from: string;
  at: string;
  lines: object[];
}

/**
 * Written just before a finding is sent: if the send is cut off, the store
 * may hold it, so the finding may no longer be revised or dropped until a
 * later `contribute` has checked.
 */
export interface SendingLine {
  type: "sending";
  id: string;
  at: string;
}

export interface JournalState {
  /** The latest version of every finding, in the order first noted. */
  findings: Map<string, FindingEvent>;
  contributed: Map<string, ContributedLine>;
  dropped: Map<string, DroppedLine>;
  parked: Map<string, ParkedLine>;
  sending: Map<string, SendingLine>;
}

/** What each kind of line about a finding records, read from its JSON. */
const LINE_READERS: Record<
  string,
  (
    state: JournalState,
    id: string,
    at: string,
    line: Record<string, unknown>,
  ) => void
> = {
  contributed: (state, id, at, line) =>
    state.contributed.set(id, {
      type: "contributed",
      id,
      ref: typeof line.ref === "string" ? line.ref : null,
      at,
    }),
  dropped: (state, id, at, line) =>
    state.dropped.set(id, {
      type: "dropped",
      id,
      reason: String(line.reason ?? ""),
      ...(typeof line.merged_into === "string"
        ? { merged_into: line.merged_into }
        : {}),
      at,
    }),
  parked: (state, id, at, line) =>
    state.parked.set(id, { type: "parked", id, to: String(line.to ?? ""), at }),
  sending: (state, id, at) =>
    state.sending.set(id, { type: "sending", id, at }),
};

/** A line that is not JSON at all: what a write cut off part-way leaves. */
function torn(text: string): boolean {
  try {
    JSON.parse(text);
    return false;
  } catch (error) {
    return error instanceof SyntaxError;
  }
}

/**
 * Written by `appendLines` after it finds the journal ending part-way
 * through a line, so a reader can tell that line from damage.
 */
interface TornLine {
  type: "torn";
  at: string;
}

function isTornMarker(text: string | undefined): boolean {
  if (text === undefined || torn(text)) return false;
  const value: unknown = JSON.parse(text);
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).type === "torn"
  );
}

function readLine(state: JournalState, text: string, where: string): void {
  const line = parseObject(text, where);
  if (line.type === "torn") return;
  if (line.type === "adopted") {
    if (!Array.isArray(line.lines))
      throw new Error(`${where} is not an adoption`);
    for (const inner of line.lines) {
      const text = JSON.stringify(inner);
      const type = parseObject(text, where).type;
      if (type === "adopted" || type === "torn")
        throw new Error(`${where} holds a ${String(type)} line in an adoption`);
      readLine(state, text, where);
    }
    return;
  }
  if (line.type === "finding") {
    const finding = parseEvent(text) as FindingEvent;
    state.findings.set(finding.id, finding);
    // Noted again after it was parked: it was adopted back.
    state.parked.delete(finding.id);
    return;
  }
  const reader = LINE_READERS[String(line.type)];
  if (
    reader === undefined ||
    typeof line.id !== "string" ||
    typeof line.at !== "string"
  )
    throw new Error(`${where} is not a journal line`);
  reader(state, line.id, line.at, line);
}

/**
 * A cut-off write is either still the journal's unfinished end, or was
 * followed by the marker the next append wrote. Any other line that is not
 * JSON is damage, and reading past it could lose findings.
 */
function skipTorn(
  where: string,
  unfinished: boolean,
  next: string | undefined,
): void {
  if (!unfinished && !isTornMarker(next))
    throw new Error(
      `${where} is not JSON and no cut-off write explains it: the journal is damaged; repair or move it before going on`,
    );
  console.error(`${where}: skipping a line a cut-off write left incomplete`);
}

export function readJournal(path: string): JournalState {
  const state: JournalState = {
    findings: new Map(),
    contributed: new Map(),
    dropped: new Map(),
    parked: new Map(),
    sending: new Map(),
  };
  if (!existsSync(path)) return state;
  // The last element is what follows the final newline: empty unless a write
  // was cut off part-way.
  const raw = readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));
  const lines = raw
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => text.trim() !== "");
  for (const [position, { text, index }] of lines.entries()) {
    const where = `${path}:${index + 1}`;
    if (!torn(text)) readLine(state, text, where);
    else skipTorn(where, index === raw.length - 1, lines[position + 1]?.text);
  }
  return state;
}

/**
 * Refuse to change a finding a cut-off send may already have stored: a
 * changed copy under the same id would be a conflict in the store.
 */
function refuseIfSending(state: JournalState, id: string): void {
  if (state.sending.has(id))
    throw new Error(
      `finding ${id} may already be in the store (a send was cut off); run reflect.ts contribute first, which checks`,
    );
}

/** Mark findings as being sent, just before the store is asked to append them. */
export function markSending(path: string, ids: readonly string[]): void {
  const at = nowAt();
  appendLines(
    path,
    ids.map((id): SendingLine => ({ type: "sending", id, at })),
  );
}

/** Findings neither contributed, dropped nor parked. */
export function unsent(state: JournalState): FindingEvent[] {
  return [...state.findings.values()].filter(
    (finding) =>
      !state.contributed.has(finding.id) &&
      !state.dropped.has(finding.id) &&
      !state.parked.has(finding.id),
  );
}

export function appendLines(path: string, lines: readonly object[]): void {
  if (lines.length === 0) return;
  mkdirSync(dirname(path), { recursive: true });
  // After a cut-off write, start on a fresh line rather than finish a torn
  // one, and mark it so a reader knows the line before was cut off.
  const cutOff =
    existsSync(path) &&
    statSync(path).size > 0 &&
    !readFileSync(path, "utf8").endsWith("\n");
  const marker: TornLine = { type: "torn", at: nowAt() };
  appendFileSync(
    path,
    (cutOff ? `\n${JSON.stringify(marker)}\n` : "") +
      lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
  );
}

/** What a caller supplies to note a finding; the rest is filled in. */
export interface FindingNote {
  kind?: unknown;
  severity?: unknown;
  class?: unknown;
  target?: unknown;
  title?: unknown;
  description?: unknown;
  suggested_fix?: unknown;
  time_cost_minutes?: unknown;
  change?: Partial<Change>;
  /** Session fields the agent states: model, skills, harness, mode. */
  session?: Record<string, unknown>;
}

export interface NoteOptions {
  scriptDir: string;
  /** The skill writing the finding itself; added to the session's skills. */
  skill?: string | undefined;
  /** A recurring fact (repository and change included) the id derives from. */
  fact?: readonly string[] | undefined;
  root?: string;
  at?: string;
}

/** Build a complete finding event from a note; throws with every problem. */
export function buildFinding(
  note: FindingNote,
  options: NoteOptions,
): FindingEvent {
  const at = options.at ?? nowAt();
  const session = sessionBlock(options.scriptDir, note.session ?? {});
  if (options.skill !== undefined && !session.skills.includes(options.skill))
    session.skills = [...session.skills, options.skill];
  const measured = currentChange(options.root);
  const change: Change = { ...measured, ...(note.change ?? {}) };
  const id =
    options.fact === undefined
      ? newId(at)
      : derivedId([change.repository, ...options.fact]);
  const event: Record<string, unknown> = {
    v: 1,
    type: "finding",
    id,
    at,
    session,
    change,
    kind: note.kind,
    severity: note.severity,
    class: note.class,
    target: note.target,
    title: note.title,
    description: note.description,
    suggested_fix: note.suggested_fix,
  };
  if (note.time_cost_minutes !== undefined)
    event.time_cost_minutes = note.time_cost_minutes;
  const problems = eventProblems(event);
  if (problems.length > 0) throw new Error(problems.join("; "));
  return event as unknown as FindingEvent;
}

/**
 * Append a finding to the journal. A finding whose id the journal already
 * holds (a derived id noted again) is left as it is; returns whether it was
 * new.
 */
export function noteFinding(path: string, finding: FindingEvent): boolean {
  if (readJournal(path).findings.has(finding.id)) return false;
  appendLines(path, [finding]);
  return true;
}

/**
 * The journal, once its own unfinished adoptions of the finding's repository
 * are finished: a send mark waiting in one of them belongs in the journal
 * before anything asks whether the finding was sent.
 */
function settledJournal(path: string, id: string): JournalState {
  const repository = readJournal(path).findings.get(id)?.change.repository;
  if (repository !== undefined) finishOwnAdoptions(path, repository);
  return readJournal(path);
}

const REVISABLE = [
  "kind",
  "severity",
  "class",
  "target",
  "title",
  "description",
  "suggested_fix",
  "time_cost_minutes",
] as const;

/** Revise an unsent finding: the fields given replace the noted ones. */
export function reviseFinding(
  path: string,
  id: string,
  patch: Record<string, unknown>,
): FindingEvent {
  const state = settledJournal(path, id);
  const held = state.findings.get(id);
  if (held === undefined) throw new Error(`the journal holds no finding ${id}`);
  if (!unsent(state).some((finding) => finding.id === id))
    throw new Error(`finding ${id} has already left the journal`);
  refuseIfSending(state, id);
  const revised: Record<string, unknown> = { ...held };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "change") {
      revised.change = { ...held.change, ...(value as Partial<Change>) };
      continue;
    }
    if (!(REVISABLE as readonly string[]).includes(key))
      throw new Error(
        `${key} cannot be revised (revisable: ${REVISABLE.join(", ")}, change)`,
      );
    revised[key] = value;
  }
  const problems = eventProblems(revised);
  if (problems.length > 0) throw new Error(problems.join("; "));
  appendLines(path, [revised]);
  return revised as unknown as FindingEvent;
}

export function dropFinding(
  path: string,
  id: string,
  reason: string,
  mergedInto?: string,
): void {
  const state = settledJournal(path, id);
  if (!state.findings.has(id))
    throw new Error(`the journal holds no finding ${id}`);
  if (mergedInto !== undefined && !state.findings.has(mergedInto))
    throw new Error(`the journal holds no finding ${mergedInto} to merge into`);
  if (reason.trim() === "") throw new Error("a dropped finding needs a reason");
  refuseIfSending(state, id);
  const line: DroppedLine = { type: "dropped", id, reason, at: nowAt() };
  if (mergedInto !== undefined) line.merged_into = mergedInto;
  appendLines(path, [line]);
}

export function markContributed(
  path: string,
  stored: ReadonlyArray<{ id: string; ref: string | null }>,
): void {
  const at = nowAt();
  appendLines(
    path,
    stored.map(
      (entry): ContributedLine => ({
        type: "contributed",
        id: entry.id,
        ref: entry.ref,
        at,
      }),
    ),
  );
}

/**
 * Move the unsent findings to the pending folder for this repository, for a
 * worktree about to be removed. The pending file is written whole before the
 * journal records the move, so a failure leaves the findings where they were.
 */
export function park(
  path: string,
  repository: string,
): { file: string | null; count: number } {
  const dir = pendingDir(repository);
  settleOwnClaims(path, dir, repository);
  const state = readJournal(path);
  const findings = unsent(state);
  if (findings.length === 0) return { file: null, count: 0 };
  // A finding whose send was cut off keeps that mark wherever it goes: the
  // store may hold it, so it must not be revised before a check.
  const sending = findings.flatMap((finding) => {
    const line = state.sending.get(finding.id);
    return line === undefined ? [] : [line];
  });
  mkdirSync(dir, { recursive: true });
  const file = join(
    dir,
    `${nowAt().replaceAll(":", "")}-${randomBytes(8).toString("hex")}.jsonl`,
  );
  // Written under a temporary name and renamed, so a reflection adopting
  // pending files never reads half of one.
  const temp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  writeFileSync(
    temp,
    [...findings, ...sending]
      .map((line) => `${JSON.stringify(line)}\n`)
      .join(""),
    { flag: "wx" },
  );
  renameSync(temp, file);
  const at = nowAt();
  appendLines(
    path,
    findings.map(
      (finding): ParkedLine => ({
        type: "parked",
        id: finding.id,
        to: file,
        at,
      }),
    ),
  );
  return { file, count: findings.length };
}

/** The prefix of a pending file one reflection has claimed to adopt. */
const CLAIM_PREFIX = ".claim-";

/** The prefix of the file naming the journal a claim's key stands for. */
const OWNER_PREFIX = ".journal-";

/**
 * How old a claim must be before another reflection reconciles it: adopting
 * one file takes well under a second, so a claim this old was cut off. A
 * claim stamped `0` was set aside by a failed adoption and is due at once.
 */
export const CLAIM_STALE_MS = 10 * 60 * 1000;

/** The journal a claim is for, the pending file behind it, and its age. */
interface Claim {
  name: string;
  at: number;
  owner: string;
  original: string;
}

function claimOf(name: string): Claim | null {
  const match = /^\.claim-([0-9]+)-([0-9a-f]{16})-(.+)$/.exec(name);
  return match === null
    ? null
    : {
        name,
        at: Number(match[1]),
        owner: match[2] ?? "",
        original: match[3] ?? "",
      };
}

/** The key a journal's claims carry in their names. */
function journalKey(path: string): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16);
}

/**
 * Record which journal a key stands for, before any claim carries it, so a
 * reflection meeting a cut-off claim can ask that journal what it adopted.
 */
function recordOwner(dir: string, path: string): string {
  const key = journalKey(path);
  const file = join(dir, `${OWNER_PREFIX}${key}`);
  if (existsSync(file)) return key;
  const temp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  writeFileSync(temp, resolve(path), { flag: "wx" });
  renameSync(temp, file);
  return key;
}

/** The journal a key stands for, or `null` when no file records it. */
function ownerPath(dir: string, key: string): string | null {
  const file = join(dir, `${OWNER_PREFIX}${key}`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

/**
 * Take a pending file, or a claim, for this journal alone by renaming it to
 * a claim carrying this journal's key: of two reflections renaming one file,
 * only one succeeds. `null` when another took it first.
 */
function claimFor(
  dir: string,
  name: string,
  key: string,
  original: string,
  at = Date.now(),
): string | null {
  const claimed = join(dir, `${CLAIM_PREFIX}${at}-${key}-${original}`);
  try {
    renameSync(join(dir, name), claimed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return claimed;
}

/** What one pending file holds, read and checked. */
interface PendingFile {
  findings: FindingEvent[];
  sending: SendingLine[];
  /** The other repository a finding of the file belongs to, if any. */
  foreign: string | null;
}

function readPendingLines(
  text: string,
  file: string,
  repository: string,
): PendingFile {
  const result: PendingFile = { findings: [], sending: [], foreign: null };
  for (const [index, line] of jsonlLines(text).entries()) {
    const where = `${file}:${index + 1}`;
    const value = parseObject(line, where);
    if (value.type === "sending") {
      if (typeof value.id !== "string" || typeof value.at !== "string")
        throw new Error(`${where} is not a send mark`);
      result.sending.push({ type: "sending", id: value.id, at: value.at });
      continue;
    }
    const finding = parseEvent(line);
    if (finding.type !== "finding") continue;
    if (finding.change.repository !== repository)
      return { ...result, foreign: finding.change.repository };
    result.findings.push(finding);
  }
  return result;
}

/** The lines adopting a pending file adds: what the journal lacks of it. */
function adoptionLines(held: JournalState, pending: PendingFile): object[] {
  const ids = new Set(pending.findings.map((finding) => finding.id));
  const findings = pending.findings.filter(
    (finding) => !held.findings.has(finding.id) || held.parked.has(finding.id),
  );
  const sending = pending.sending.filter(
    (line) => ids.has(line.id) && !held.sending.has(line.id),
  );
  return [...findings, ...sending];
}

/**
 * Whether a journal took in the whole of a pending file: it holds each
 * finding, has not parked any to that same file (which is where the findings
 * were before an adoption, not after one), and holds the send mark of each
 * finding the file carries one for. A finding the journal already held lacks
 * only its mark, and without it the finding could be revised after a cut-off
 * send.
 */
function took(held: JournalState, pending: PendingFile, file: string): boolean {
  const ids = new Set(pending.findings.map((finding) => finding.id));
  return (
    pending.findings.every(
      (finding) =>
        held.findings.has(finding.id) &&
        held.parked.get(finding.id)?.to !== file,
    ) &&
    pending.sending.every(
      (line) => !ids.has(line.id) || held.sending.has(line.id),
    )
  );
}

/**
 * Whether a journal already holds part of a pending file: a finding of it
 * that the journal has not parked. Such a file belongs to that journal until
 * the rest of it lands, since another journal taking it in would hold those
 * findings twice, and the one already here would lack its send mark.
 */
function holdsPart(held: JournalState, pending: PendingFile): boolean {
  return pending.findings.some(
    (finding) => held.findings.has(finding.id) && !held.parked.has(finding.id),
  );
}

/**
 * Settle a claim whose adoption may have been cut off, against the journal
 * it was made for: removed when that journal took the file in, left to it
 * when it holds part of the file, taken for this journal when it holds none
 * of it or no longer exists. A claim whose journal
 * cannot be read, or that no file names a journal for, is reported and left.
 * Returns the claim taken, or `null`.
 */
function reconcile(
  dir: string,
  claim: Claim,
  path: string,
  key: string,
  repository: string,
): string | null {
  const where = join(dir, claim.name);
  const file = join(dir, claim.original);
  try {
    const journal = claim.owner === key ? path : ownerPath(dir, claim.owner);
    if (journal === null)
      throw new Error(`no ${OWNER_PREFIX}${claim.owner} names its journal`);
    if (existsSync(journal)) {
      const pending = readPendingLines(
        readFileSync(where, "utf8"),
        file,
        repository,
      );
      const held = readJournal(journal);
      if (pending.foreign === null && took(held, pending, file)) {
        rmSync(where, { force: true });
        return null;
      }
      if (claim.owner !== key && holdsPart(held, pending)) {
        console.error(
          `${where}: ${journal} holds part of it; left for that journal to finish adopting`,
        );
        return null;
      }
    }
  } catch (error) {
    console.error(
      `${where}: could not tell whether the journal it was claimed for adopted it (${error instanceof Error ? error.message : String(error)}); left until that journal can be read`,
    );
    return null;
  }
  return claimFor(dir, claim.name, key, claim.original);
}

/**
 * The pending files to adopt, oldest first: each unclaimed file, and each
 * claim old enough to have been cut off.
 */
function pendingCandidates(
  dir: string,
  now: number,
): Array<{ name: string; original: string; claim: Claim | null }> {
  const candidates: Array<{
    name: string;
    original: string;
    claim: Claim | null;
  }> = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith(CLAIM_PREFIX)) {
      const claim = claimOf(name);
      if (claim !== null && now - claim.at >= CLAIM_STALE_MS)
        candidates.push({ name, original: claim.original, claim });
    } else if (name.endsWith(".jsonl") && !name.startsWith("."))
      candidates.push({ name, original: name, claim: null });
  }
  return candidates.sort((a, b) => (a.original < b.original ? -1 : 1));
}

/**
 * Bring a removed worktree's parked findings of this repository into this
 * journal, then remove the pending files. Each file is claimed first, under
 * a name carrying this journal's key, so two reflections never adopt the
 * same one. A claim cut off before its file was removed is reconciled, once
 * `CLAIM_STALE_MS` old, against the journal it was made for: a finding
 * belongs to one journal at a time, so a journal that took the file in keeps
 * it. A finding already here is not added twice, and a send mark parked with
 * a finding comes with it. A file holding a finding of another repository is
 * left where it is.
 *
 * A file's lines are appended as one line, so a failed append has added all
 * of them or none: the claim is then removed or given back whole. When the
 * journal cannot be read to tell which, the claim is stamped `0`, so the
 * next reflection that can read this journal settles it.
 */
export function adoptPending(
  path: string,
  repository: string,
  append: (path: string, lines: readonly object[]) => void = appendLines,
  dir = pendingDir(repository),
): number {
  if (!existsSync(dir)) return 0;
  const key = recordOwner(dir, path);
  let adopted = 0;
  for (const { name, claim } of pendingCandidates(dir, Date.now())) {
    const original = claim?.original ?? name;
    const claimed =
      claim === null
        ? claimFor(dir, name, key, original)
        : reconcile(dir, claim, path, key, repository);
    if (claimed === null) continue;
    const read = readClaimed(path, repository, dir, claimed, original);
    if (read === null) continue;
    const { pending, lines } = read;
    if (lines.length > 0) {
      const adoption: AdoptedLine = {
        type: "adopted",
        from: original,
        at: nowAt(),
        lines,
      };
      try {
        append(path, [adoption]);
      } catch (error) {
        settleFailedAdoption(path, pending, dir, claimed, key, original);
        throw error;
      }
    }
    adopted += lines.filter(
      (line) => (line as { type?: unknown }).type === "finding",
    ).length;
    rmSync(claimed, { force: true });
  }
  return adopted;
}

/**
 * A claimed file's lines and what adopting them adds; `null`, with the file
 * given back, when it holds another repository's finding. A failure the
 * process survived gives the file back under its own name, so the next
 * reflection meets the same failure rather than a claim it must wait out.
 */
function readClaimed(
  path: string,
  repository: string,
  dir: string,
  claimed: string,
  original: string,
): { pending: PendingFile; lines: object[] } | null {
  const file = join(dir, original);
  try {
    const pending = readPendingLines(
      readFileSync(claimed, "utf8"),
      file,
      repository,
    );
    if (pending.foreign !== null) {
      renameSync(claimed, file);
      console.error(
        `${file}: holds a finding of ${pending.foreign}, not ${repository}; left where it is`,
      );
      return null;
    }
    return { pending, lines: adoptionLines(readJournal(path), pending) };
  } catch (error) {
    releaseClaim(claimed, file);
    throw error;
  }
}

/**
 * After an append failed, remove the claim if its line landed, else give it
 * back whole. When the journal holds part of the file, or cannot be read,
 * stamp the claim `0` instead: the file is this journal's to finish, and
 * only this journal can tell whether it holds the lines.
 */
function settleFailedAdoption(
  path: string,
  pending: PendingFile,
  dir: string,
  claimed: string,
  key: string,
  original: string,
): void {
  const file = join(dir, original);
  const due = join(dir, `${CLAIM_PREFIX}0-${key}-${original}`);
  let held: JournalState;
  try {
    held = readJournal(path);
  } catch (error) {
    setAside(claimed, due);
    console.error(
      `${existsSync(due) ? due : claimed}: could not tell whether ${path} adopted it (${error instanceof Error ? error.message : String(error)}); the next reflection that can read that journal settles it`,
    );
    return;
  }
  if (took(held, pending, file)) rmSync(claimed, { force: true });
  else if (holdsPart(held, pending)) setAside(claimed, due);
  else releaseClaim(claimed, file);
}

/**
 * Stamp a claim `0`, due at once for its own journal; another journal
 * leaves it while that one can be read and holds part of it.
 */
function setAside(claimed: string, due: string): void {
  try {
    renameSync(claimed, due);
  } catch {
    // The claim stays under its own stamp; it is due once stale.
  }
}

/**
 * Finish this journal's own unfinished adoptions, whatever their age: a claim
 * the journal took in whole is removed, and one it holds part of has the rest
 * appended, so every send mark the journal is owed is in the journal before
 * anything reads its send marks. Every operation that asks whether a finding
 * was sent calls this first. A claim of a file it holds none of, or that
 * holds another repository's finding, is left and returned. A journal that
 * cannot be read, or an append that fails, throws.
 */
export function finishOwnAdoptions(
  path: string,
  repository: string,
  dir = pendingDir(repository),
): Claim[] {
  const left: Claim[] = [];
  if (!existsSync(dir)) return left;
  const key = journalKey(path);
  for (const name of readdirSync(dir)) {
    const claim = claimOf(name);
    if (claim === null || claim.owner !== key) continue;
    const where = join(dir, name);
    const file = join(dir, claim.original);
    const pending = readPendingLines(
      readFileSync(where, "utf8"),
      file,
      repository,
    );
    const held = readJournal(path);
    if (pending.foreign !== null) left.push(claim);
    else if (took(held, pending, file)) rmSync(where, { force: true });
    else if (holdsPart(held, pending)) {
      const adoption: AdoptedLine = {
        type: "adopted",
        from: claim.original,
        at: nowAt(),
        lines: adoptionLines(held, pending),
      };
      appendLines(path, [adoption]);
      rmSync(where, { force: true });
    } else left.push(claim);
  }
  return left;
}

/**
 * Settle this journal's own claims before it parks: a worktree about to be
 * removed takes the answer to "did I adopt this" with it. Its unfinished
 * adoptions are finished, so the park carries them whole, and every other
 * claim is given back. With none left, the record naming this journal goes
 * too.
 */
function settleOwnClaims(path: string, dir: string, repository: string): void {
  for (const claim of finishOwnAdoptions(path, repository, dir))
    renameSync(join(dir, claim.name), join(dir, claim.original));
  rmSync(join(dir, `${OWNER_PREFIX}${journalKey(path)}`), { force: true });
}

/** Rename a claimed file back; a failure to do so is reported, not thrown. */
function releaseClaim(claimed: string, original: string): void {
  try {
    renameSync(claimed, original);
  } catch (error) {
    console.error(
      `${claimed}: could not be given back as ${original} (${error instanceof Error ? error.message : String(error)}); it is reconciled once ${CLAIM_STALE_MS / 60_000} minutes old`,
    );
  }
}
