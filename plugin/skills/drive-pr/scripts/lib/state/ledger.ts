/**
 * The drive ledger: the drive state's resumable subset, mirrored into one
 * hidden-marker comment on the pull request, so a drive started in another
 * clone, on another machine, resumes where the last driver left off instead
 * of at round zero.
 *
 * This module is the pure half: the ledger's shape, how it is rendered into
 * a comment body within the forge's size limit and parsed back, the
 * append-only takeover claim, which comments are trusted, and how a ledger
 * seeds a clone's state. `ledger-forge.ts` reads and writes the comments;
 * `ledger-mirror.ts` writes the ledger from the state at each round boundary,
 * park and takeover; `lib/driver/ledger.ts` seeds, admits and arbitrates.
 *
 * The comment opens with `<!-- drive-pr-ledger -->`, carries a short summary
 * a person can read on the pull request, and holds the data as JSON inside a
 * second HTML comment. Every `<` and `>` in that JSON is written as a Unicode
 * escape, which JSON allows inside a string and which leaves nothing in the
 * data that could close the comment early.
 *
 * A ledger is trusted only when its author is the drive's own login or
 * carries the owner, member or collaborator association GitHub computes from
 * repository permissions; any other comment opening with a marker is ignored
 * and reported. When two creations race, the lower comment id is canonical.
 */
import { swallow } from "../../../../../shared/errors.ts";
import { isRecord } from "../../../../../shared/guards.ts";
import { stallThresholdMs } from "../doctor.ts";
import { TRUSTED_ASSOCIATIONS } from "../../summary-findings.ts";
import {
  type DriveState,
  type HeldItem,
  type ParkedItem,
  type QuotaParkRecord,
  isUsableState,
} from "./schema.ts";
import { type TakeoverRecord, isTakeoverRecord } from "./takeover.ts";
import {
  type UnattendedDecision,
  decisionsSection,
  isUnattendedDecision,
} from "./decisions.ts";
import { type DriveEvent, isOptionalEvents } from "./events.ts";
import { type ArbiterRuling, isOptionalRulings } from "./rulings.ts";

export const LEDGER_MARKER = "<!-- drive-pr-ledger -->";
export const CLAIM_MARKER = "<!-- drive-pr-takeover-claim -->";
const LEDGER_DATA = "drive-pr-ledger-data";
const CLAIM_DATA = "drive-pr-takeover-claim-data";

/** The ledger shape this version reads and writes. */
export const LEDGER_VERSION = 1;

/** GitHub's issue-comment body limit, measured here in UTF-8 bytes. */
export const FORGE_BODY_LIMIT = 65_536;

/** How much of the handoff narrative travels with the ledger. */
export const NARRATIVE_LINES = 20;

/** One held item as the ledger carries it; `outcome` is the first cut. */
export interface LedgerHeld {
  key: string;
  kind: "thread" | "finding";
  round: number;
  actor: string;
  outcome?: "accepted" | "moot";
  commentUrl?: string;
  /** A held finding's answer, posted once its push lands; cut with `outcome`. */
  reason?: string;
  verifiedSha?: string;
}

export interface LedgerDriver {
  /** The working tree driving (`resolveActor`). */
  actor: string;
  /** The clone, by machine and state directory: two clones never share one. */
  clone: string;
  /** When this ledger was written: the driver's heartbeat across clones. */
  heartbeat: string;
  /** `stopped` once the driver has exited, with its exit code. */
  state: "running" | "stopped";
  exit?: number;
  /** The driver's lock acquisition time: which run of that tree it is. */
  started?: string;
  /** Its claim position: its own claim's id, or the position its clone's ledger recorded when it continued that ledger. */
  position?: number;
}

/** A takeover claim the ledger's writer knows to be in force. */
export interface LedgerClaimRef {
  id: number;
  clone: string;
  generation: number;
}

export interface Ledger {
  ledgerVersion: number;
  /** Monotonic: every write is one past the highest the writer has seen. */
  generation: number;
  pr: number;
  round: number;
  /** The passes on `attemptsHead`: the per-head budget a resume keeps. */
  attempts: number;
  attemptsHead: string;
  /** The deadline restarts already spent, shared with a takeover. */
  deadlineRetries: number;
  phase: string;
  lastCountedHead: string;
  verifiedSha: string;
  readyMarkedRound: number;
  parked: ParkedItem[];
  held: LedgerHeld[];
  /** The quota park, without the account it belongs to. */
  quotaPark: Omit<QuotaParkRecord, "account"> | null;
  takeovers: LedgerTakeover[];
  claims: LedgerClaimRef[];
  /** The decisions the agent took and recorded (`decisions.ts`). */
  decisions: UnattendedDecision[];
  /** Self-restarts and re-arms (`events.ts`); absent in a ledger written before them. */
  events?: DriveEvent[];
  /**
   * The review arbiter's rulings (`rulings.ts`), so a drive recovered in
   * another clone parks under the same boundary. Absent in a ledger written
   * before they were carried, which seeds none over the local ones.
   */
  rulings?: ArbiterRuling[];
  driver: LedgerDriver;
  /** The handoff narrative's last lines. */
  narrative: string[];
  /** What the size cut dropped from this body, in order. */
  cut: string[];
}

/** A takeover record as the ledger carries it: without either account. */
export type LedgerTakeover = Omit<TakeoverRecord, "fromAccount" | "toAccount">;

export type ParsedLedger =
  | { kind: "ledger"; ledger: Ledger }
  | { kind: "unknown-version"; version: unknown }
  | { kind: "malformed"; reason: string };

export interface TakeoverClaim {
  actor: string;
  clone: string;
  /** The ledger generation the claimant read before claiming. */
  generation: number;
  at: string;
}

/** The ledger a state renders to, before any size cut. */
export function ledgerFromState(
  s: DriveState,
  opts: {
    generation: number;
    driver: LedgerDriver;
    narrative: string[];
    claims: LedgerClaimRef[];
  },
): Ledger {
  return {
    ledgerVersion: LEDGER_VERSION,
    generation: opts.generation,
    pr: s.pr,
    round: s.rounds,
    attempts: s.attempts,
    attemptsHead: s.attemptsHead,
    deadlineRetries: s.deadlineRetries ?? 0,
    phase: s.phase,
    lastCountedHead: s.lastCountedHead,
    verifiedSha: s.verifiedSha,
    readyMarkedRound: s.readyMarkedRound,
    parked: s.parked.map((p) => ({
      ...p,
      reason: redact(p.reason),
      ...(p.record === undefined ? {} : { record: redact(p.record) }),
    })),
    held: s.held.map(ledgerHeld),
    quotaPark: withoutAccount(s.quotaPark),
    takeovers: (s.takeovers ?? []).map(
      ({ fromAccount: _from, toAccount: _to, ...t }) => t,
    ),
    claims: opts.claims,
    decisions: (s.decisions ?? []).map((d) => ({
      ...d,
      what: redact(d.what),
      record: redact(d.record),
      reverse: redact(d.reverse),
    })),
    events: s.events ?? [],
    rulings: s.rulings ?? [],
    driver: opts.driver,
    narrative: opts.narrative.slice(-NARRATIVE_LINES).map(redact),
    cut: [],
  };
}

/** An email-shaped string anywhere in a text. */
const EMAIL =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * An account identifier as `lib/identity.ts` writes one: an account hash, or
 * a credential's fingerprint.
 */
const ACCOUNT_ID = /\b(?:acct-[0-9a-f]{16}|(?:token|api-key):[0-9a-f]{12})\b/g;

/**
 * `text` with every email-shaped string and account identifier replaced: the
 * narrative, the parked reasons and the held findings' answers are
 * agent-authored, and a pull request comment is public to everyone who can
 * read the repository.
 */
export function redact(text: string): string {
  return text.replace(EMAIL, "<redacted>").replace(ACCOUNT_ID, "<redacted>");
}

function withoutAccount(
  park: QuotaParkRecord | null,
): Omit<QuotaParkRecord, "account"> | null {
  if (park === null) return null;
  const { account: _account, ...rest } = park;
  return rest;
}

function ledgerHeld(h: HeldItem): LedgerHeld {
  return {
    key: h.key,
    kind: h.kind,
    round: h.round,
    actor: h.actor,
    outcome: h.outcome,
    ...(h.commentUrl === undefined ? {} : { commentUrl: h.commentUrl }),
    ...(h.reason === undefined ? {} : { reason: redact(h.reason) }),
    ...(h.verifiedSha === undefined ? {} : { verifiedSha: h.verifiedSha }),
  };
}

/** JSON with every `<` and `>` escaped, so it cannot close an HTML comment. */
function commentSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
}

/** A Markdown line whose agent-authored parts cannot open an HTML tag. */
function summaryLine(line: string): string {
  return line.replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** One line of agent-authored text, safe in the visible summary. */
function summaryText(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .trim();
}

function ledgerBody(l: Ledger, parkedList: boolean): string {
  const d = l.driver;
  const lines = [
    LEDGER_MARKER,
    `**Drive ledger** · \`drive-pr-ledger\` v${l.ledgerVersion} · generation ${l.generation}. Written by the drive at each round boundary, park and takeover; an edit here is overwritten.`,
    "",
    `Round ${l.round}, phase \`${l.phase === "" ? "unset" : l.phase}\` · driver \`${d.actor}\` ${d.state === "running" ? "running" : `stopped${d.exit === undefined ? "" : ` (exit ${d.exit})`}`}, last heartbeat ${d.heartbeat} · ${l.parked.length} parked, ${l.held.length} held, ${l.takeovers.length} takeover(s)`,
  ];
  if (parkedList && l.parked.length > 0) {
    lines.push("", "Parked, awaiting a person:");
    for (const p of l.parked)
      lines.push(
        `- \`${p.key}\` (${p.kind}, ${p.class ?? "no class"}, round ${p.round}): ${summaryText(p.reason)}`,
      );
  }
  if (l.decisions.length > 0)
    lines.push("", ...decisionsSection(l.decisions).map(summaryLine));
  if (l.cut.length > 0)
    lines.push(
      "",
      `Cut to the forge's size limit: ${l.cut.join(", ")} dropped.`,
    );
  lines.push("", `<!-- ${LEDGER_DATA}`, commentSafeJson(l), "-->");
  return `${lines.join("\n")}\n`;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * The comment body for `ledger`, cut to `limit`: held items' outcomes go
 * first, the narrative second, then the visible list of parked decisions
 * (the data keeps every one). A parked decision is never dropped, so a body
 * that still does not fit is an error, not a smaller ledger.
 */
export function renderLedger(
  ledger: Ledger,
  limit = FORGE_BODY_LIMIT,
): { body: string; ledger: Ledger } | { error: string } {
  let l: Ledger = { ...ledger, cut: [] };
  let body = ledgerBody(l, true);
  if (bytes(body) <= limit) return { body, ledger: l };
  l = {
    ...l,
    held: l.held.map(({ outcome: _dropped, reason: _answer, ...rest }) => rest),
    cut: ["held items' outcomes"],
  };
  body = ledgerBody(l, true);
  if (bytes(body) <= limit) return { body, ledger: l };
  l = { ...l, narrative: [], cut: [...l.cut, "the narrative"] };
  body = ledgerBody(l, true);
  if (bytes(body) <= limit) return { body, ledger: l };
  l = { ...l, cut: [...l.cut, "the visible list of parked decisions"] };
  body = ledgerBody(l, false);
  if (bytes(body) <= limit) return { body, ledger: l };
  return {
    error: `the parked decisions alone exceed the forge's ${limit}-byte comment limit; the ledger was not written`,
  };
}

function dataBlock(body: string, name: string): string | null {
  const open = `<!-- ${name}\n`;
  const start = body.indexOf(open);
  if (start === -1) return null;
  const end = body.indexOf("\n-->", start + open.length);
  if (end === -1) return null;
  return body.slice(start + open.length, end);
}

/** Does this comment open with the marker (a quotation mid-body does not)? */
export function opensWith(body: string, marker: string): boolean {
  return body.replaceAll("\r", "").trimStart().startsWith(marker);
}

const isText = (v: unknown): v is string => typeof v === "string";
const isCount = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

/** A held item's round: a count, or `-1` for an unconfirmed hold. */
const isHeldRound = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= -1;

function isLedgerHeld(v: unknown): v is LedgerHeld {
  return (
    isRecord(v) &&
    isText(v.key) &&
    v.key !== "" &&
    (v.kind === "thread" || v.kind === "finding") &&
    isHeldRound(v.round) &&
    isText(v.actor) &&
    (v.outcome === undefined ||
      v.outcome === "accepted" ||
      v.outcome === "moot") &&
    (v.commentUrl === undefined || isText(v.commentUrl)) &&
    (v.reason === undefined || isText(v.reason)) &&
    (v.verifiedSha === undefined || isText(v.verifiedSha))
  );
}

function isLedgerDriver(v: unknown): v is LedgerDriver {
  return (
    isRecord(v) &&
    isText(v.actor) &&
    isText(v.clone) &&
    isText(v.heartbeat) &&
    Number.isFinite(Date.parse(v.heartbeat)) &&
    (v.state === "running" || v.state === "stopped") &&
    (v.exit === undefined || isCount(v.exit)) &&
    (v.started === undefined || isText(v.started)) &&
    (v.position === undefined || isCount(v.position))
  );
}

function isClaimRef(v: unknown): v is LedgerClaimRef {
  return (
    isRecord(v) && isCount(v.id) && isText(v.clone) && isCount(v.generation)
  );
}

/** The fields of a version-1 ledger, each checked; `''` when all hold. */
function ledgerFault(v: Record<string, unknown>): string {
  const checks: Array<[string, boolean]> = [
    ["generation", isCount(v.generation) && v.generation > 0],
    ["pr", isCount(v.pr)],
    ["round", isCount(v.round)],
    ["attempts", isCount(v.attempts)],
    ["attemptsHead", isText(v.attemptsHead)],
    ["deadlineRetries", isCount(v.deadlineRetries)],
    ["phase", isText(v.phase)],
    ["lastCountedHead", isText(v.lastCountedHead)],
    ["verifiedSha", isText(v.verifiedSha)],
    ["readyMarkedRound", isCount(v.readyMarkedRound)],
    ["parked", Array.isArray(v.parked)],
    ["held", Array.isArray(v.held) && v.held.every(isLedgerHeld)],
    ["quotaPark", v.quotaPark === null || isRecord(v.quotaPark)],
    [
      "takeovers",
      Array.isArray(v.takeovers) &&
        v.takeovers.every(
          (t) =>
            isRecord(t) &&
            isTakeoverRecord({ ...t, fromAccount: null, toAccount: null }),
        ),
    ],
    ["claims", Array.isArray(v.claims) && v.claims.every(isClaimRef)],
    [
      "decisions",
      Array.isArray(v.decisions) && v.decisions.every(isUnattendedDecision),
    ],
    ["events", isOptionalEvents(v.events)],
    ["rulings", isOptionalRulings(v.rulings)],
    ["driver", isLedgerDriver(v.driver)],
    ["narrative", Array.isArray(v.narrative) && v.narrative.every(isText)],
    ["cut", Array.isArray(v.cut) && v.cut.every(isText)],
  ];
  return checks
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
    .join(", ");
}

/** Parse a ledger comment body; `null` when the body is not a ledger. */
export function parseLedger(body: string): ParsedLedger | null {
  if (!opensWith(body, LEDGER_MARKER)) return null;
  const raw = dataBlock(body.replaceAll("\r", ""), LEDGER_DATA);
  if (raw === null) return { kind: "malformed", reason: "no data block" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: "malformed", reason: "the data block is not JSON" };
  }
  if (!isRecord(data))
    return { kind: "malformed", reason: "the data block is not an object" };
  // Only a version number reads as a future ledger; anything else is damage.
  if (data.ledgerVersion !== LEDGER_VERSION)
    return isCount(data.ledgerVersion) && data.ledgerVersion > LEDGER_VERSION
      ? { kind: "unknown-version", version: data.ledgerVersion }
      : {
          kind: "malformed",
          reason: `ledgerVersion ${JSON.stringify(data.ledgerVersion) ?? "is missing"} is not a version`,
        };
  const fault = ledgerFault(data);
  if (fault !== "")
    return { kind: "malformed", reason: `ill-formed field(s): ${fault}` };
  return { kind: "ledger", ledger: data as unknown as Ledger };
}

/** The append-only takeover claim's comment body. */
export function renderClaim(claim: TakeoverClaim): string {
  return [
    CLAIM_MARKER,
    `**Drive claim** · \`drive-pr-takeover-claim\` · a driver in another clone claims the drive of this pull request: a takeover from a driver whose ledger heartbeat is older than the lease window, or a start where no driver of that clone held it. Of the claims on one ledger generation the earliest wins; a driver that finds a newer claim than its own stops at its next round boundary.`,
    "",
    `<!-- ${CLAIM_DATA}`,
    commentSafeJson(claim),
    "-->",
    "",
  ].join("\n");
}

export function parseClaim(body: string): TakeoverClaim | null {
  if (!opensWith(body, CLAIM_MARKER)) return null;
  const raw = dataBlock(body.replaceAll("\r", ""), CLAIM_DATA);
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch (err) {
    // A claim whose data does not parse claims nothing.
    swallow(err, "a takeover claim's data is not JSON");
    return null;
  }
  if (
    !isRecord(v) ||
    !isText(v.actor) ||
    !isText(v.clone) ||
    !isCount(v.generation) ||
    !isText(v.at)
  )
    return null;
  return {
    actor: v.actor,
    clone: v.clone,
    generation: v.generation,
    at: v.at,
  };
}

/** One issue comment, as far as the ledger reads it. */
export interface ForgeComment {
  id: number;
  login: string;
  association: string;
  updatedAt: string;
  body: string;
}

export interface ClaimComment {
  id: number;
  claim: TakeoverClaim;
}

/** What the comments on a pull request say about its drive. */
export interface LedgerSnapshot {
  /**
   * The lowest-id trusted ledger comment whose data reads (in this version
   * or another), and what it parses to.
   */
  canonical: { comment: ForgeComment; parsed: ParsedLedger } | null;
  /** Every other trusted, readable ledger comment: a lost creation race. */
  duplicates: ForgeComment[];
  /**
   * Trusted comments opening with the ledger marker whose data does not read
   * (a person's comment, a damaged body): reported, never overwritten.
   */
  malformed: ForgeComment[];
  /** Comments opening with a marker whose author is not trusted. */
  untrusted: ForgeComment[];
  /** Trusted, well-formed takeover claims, ascending by id. */
  claims: ClaimComment[];
  /** The highest generation among the trusted ledgers, `0` for none. */
  maxGeneration: number;
}

export function isTrusted(c: ForgeComment, selfLogin: string | null): boolean {
  return (
    (selfLogin !== null && selfLogin !== "" && c.login === selfLogin) ||
    TRUSTED_ASSOCIATIONS.has(c.association)
  );
}

/** Which drive marker a comment opens with, from a trusted author or not. */
function markerKind(
  c: ForgeComment,
  selfLogin: string | null,
): "ledger" | "claim" | "untrusted" | null {
  const isLedger = opensWith(c.body, LEDGER_MARKER);
  const isClaim = opensWith(c.body, CLAIM_MARKER);
  if (!isLedger && !isClaim) return null;
  if (!isTrusted(c, selfLogin)) return "untrusted";
  return isClaim ? "claim" : "ledger";
}

interface Sorted {
  ledgers: Array<{ comment: ForgeComment; parsed: ParsedLedger }>;
  malformed: ForgeComment[];
  untrusted: ForgeComment[];
  claims: ClaimComment[];
  maxGeneration: number;
}

/** File one comment under what it is. */
function sortComment(
  into: Sorted,
  c: ForgeComment,
  kind: ReturnType<typeof markerKind>,
): void {
  if (kind === "untrusted") into.untrusted.push(c);
  if (kind === "claim") {
    const claim = parseClaim(c.body);
    if (claim !== null) into.claims.push({ id: c.id, claim });
  }
  if (kind !== "ledger") return;
  const parsed = parseLedger(c.body);
  if (parsed === null || parsed.kind === "malformed") {
    into.malformed.push(c);
    return;
  }
  into.ledgers.push({ comment: c, parsed });
  if (parsed.kind === "ledger")
    into.maxGeneration = Math.max(into.maxGeneration, parsed.ledger.generation);
}

export function snapshotFrom(
  comments: readonly ForgeComment[],
  selfLogin: string | null,
): LedgerSnapshot {
  const into: Sorted = {
    ledgers: [],
    malformed: [],
    untrusted: [],
    claims: [],
    maxGeneration: 0,
  };
  for (const c of [...comments].sort((a, b) => a.id - b.id))
    sortComment(into, c, markerKind(c, selfLogin));
  const [first, ...rest] = into.ledgers;
  return {
    canonical: first ?? null,
    duplicates: rest.map((l) => l.comment),
    malformed: into.malformed,
    untrusted: into.untrusted,
    claims: into.claims,
    maxGeneration: into.maxGeneration,
  };
}

/**
 * The claims in force: of the claims on one ledger generation, the earliest
 * (lowest id) wins and every later one has stood down, so it counts for
 * nothing. A winner whose owner never wrote the ledger past that generation
 * is abandoned (its seeding failed, or it died before its first write): a
 * claim on the same generation posted more than the lease window after it
 * (`stallThresholdMs`) wins in its place, so an abandoned claim never holds
 * the drive for good.
 */
export function effectiveClaims(
  claims: readonly ClaimComment[],
): ClaimComment[] {
  const window = stallThresholdMs();
  const byGeneration = new Map<number, ClaimComment>();
  for (const c of [...claims].sort((a, b) => a.id - b.id)) {
    const winner = byGeneration.get(c.claim.generation);
    if (
      winner === undefined ||
      Date.parse(c.claim.at) - Date.parse(winner.claim.at) > window
    )
      byGeneration.set(c.claim.generation, c);
  }
  return [...byGeneration.values()].sort((a, b) => a.id - b.id);
}

/**
 * The claim that ends this driver's drive: one in force, from another
 * clone, newer than `floor` (this driver's own claim, or the newest claim
 * in force when it started); or, when this driver took the drive by its own
 * claim (`own`), a rival's earlier claim on the same generation, which won
 * even if the read after posting did not show it yet. `own` is counted
 * whether or not the listing shows it, so a rival it beat never reads as in
 * force.
 */
export function newerClaim(
  claims: readonly ClaimComment[],
  floor: number,
  ownClone: string,
  own: ClaimComment | null = null,
): ClaimComment | null {
  const all =
    own === null || claims.some((c) => c.id === own.id)
      ? claims
      : [...claims, own];
  const inForce = effectiveClaims(all);
  const beaten = inForce.find(
    (c) =>
      own !== null &&
      c.claim.generation === own.claim.generation &&
      c.id !== own.id &&
      c.claim.clone !== ownClone,
  );
  return (
    beaten ??
    inForce.find((c) => c.id > floor && c.claim.clone !== ownClone) ??
    null
  );
}

/** The driver a stop or a recovery means to mark stopped. */
export interface StoppedDriver {
  actor: string;
  clone: string;
  started: string;
}

/**
 * The ledger a stop may mark stopped: one that still names `who` as its
 * running driver (tree, clone and, where recorded, the run) with no claim in
 * force from another clone past its recorded position. Anything else is a
 * successor's ledger, or no ledger, and is left alone; `why` says which.
 */
export function ledgerOfStoppedDriver(
  snapshot: LedgerSnapshot,
  who: StoppedDriver,
): { ledger: Ledger; own: ClaimComment | null } | { why: string } {
  const parsed = snapshot.canonical?.parsed;
  if (parsed?.kind !== "ledger") return { why: "there is no ledger to mark" };
  const d = parsed.ledger.driver;
  if (d.state !== "running")
    return { why: "it already says its driver stopped" };
  if (
    d.clone !== who.clone ||
    d.actor !== who.actor ||
    (d.started !== undefined && d.started !== who.started)
  )
    return {
      why: `it names another driver (${d.actor}), which now owns it`,
    };
  // A position that is this clone's own claim is arbitrated as the live
  // driver arbitrates it, so a rival that beat that claim is seen too.
  const own =
    snapshot.claims.find(
      (c) => c.id === d.position && c.claim.clone === who.clone,
    ) ?? null;
  const claim = newerClaim(snapshot.claims, d.position ?? 0, who.clone, own);
  if (d.position !== undefined && claim !== null)
    return {
      why: `another clone's claim (comment ${claim.id}) took the drive over`,
    };
  return { ledger: parsed.ledger, own };
}

/** The highest id among the claims in force, `0` for none. */
export function claimFloor(claims: readonly ClaimComment[]): number {
  return effectiveClaims(claims).reduce((max, c) => Math.max(max, c.id), 0);
}

/** A ledger's held items that carry what a held item needs. */
export function heldFromLedger(held: readonly LedgerHeld[]): {
  held: HeldItem[];
  dropped: string[];
} {
  const out: HeldItem[] = [];
  const dropped: string[] = [];
  for (const h of held) {
    const answerless = h.kind === "finding" && (h.reason ?? "") === "";
    if (h.outcome === undefined || answerless) {
      dropped.push(h.key);
      continue;
    }
    out.push({
      key: h.key,
      kind: h.kind,
      outcome: h.outcome,
      round: h.round,
      actor: h.actor,
      ...(h.commentUrl === undefined ? {} : { commentUrl: h.commentUrl }),
      ...(h.reason === undefined ? {} : { reason: h.reason }),
      ...(h.verifiedSha === undefined ? {} : { verifiedSha: h.verifiedSha }),
    });
  }
  return { held: out, dropped };
}

/**
 * `local` with the ledger's resumable subset laid over it. The quota park
 * stays this clone's own: the ledger carries no account, and a wall another
 * clone hit is met again, and slept through or parked on, by this clone's
 * pass. `dropped` names
 * the held items the size cut left without an outcome: they are not held
 * here, and the round triages them afresh. An `error` when the result is not
 * a usable state, so a ledger can never seed a state the store would refuse.
 *
 * The ledger's rounds replace this clone's. A ledger behind this clone's
 * round count (another clone reset the drive and published afresh) is a
 * different round history, so the local records positioned in the old one
 * (the reflect and escalation positions, the escalation's claim, the
 * per-round finding paths) are cleared rather than carried past the rounds
 * they would then exceed.
 */
export function seedFromLedger(
  local: DriveState,
  l: Ledger,
): { state: DriveState; dropped: string[] } | { error: string } {
  if (l.pr !== local.pr)
    return {
      error: `the ledger is PR #${l.pr}'s, not PR #${local.pr}'s`,
    };
  const { held, dropped } = heldFromLedger(l.held);
  const rewound =
    l.round < local.rounds
      ? {
          lastReflectedRound: 0,
          lastReflectedAttempts: 0,
          lastEscalatedRound: 0,
          lastEscalatedInvariant: "",
          roundPaths: [],
        }
      : {};
  const state: DriveState = {
    ...local,
    ...rewound,
    rounds: l.round,
    attempts: l.attempts,
    attemptsHead: l.attemptsHead,
    deadlineRetries: l.deadlineRetries,
    phase: l.phase,
    lastCountedHead: l.lastCountedHead,
    verifiedSha: l.verifiedSha,
    readyMarkedRound: l.readyMarkedRound,
    parked: l.parked,
    held,
    takeovers: l.takeovers.map((t) => ({
      ...t,
      fromAccount: null,
      toAccount: null,
    })),
    decisions: l.decisions,
    events: l.events ?? local.events ?? [],
    ...(l.rulings === undefined ? {} : { rulings: l.rulings }),
    ledgerGeneration: l.generation,
  };
  if (!isUsableState(state, local.pr))
    return {
      error: `the ledger (generation ${l.generation}) does not describe a usable drive state`,
    };
  return { state, dropped };
}
