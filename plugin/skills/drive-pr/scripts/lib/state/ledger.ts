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
import { TRUSTED_ASSOCIATIONS } from "../../summary-findings.ts";
import { isAccountHash } from "../identity.ts";
import {
  type DriveState,
  type HeldItem,
  type ParkedItem,
  type QuotaParkRecord,
  isUsableState,
} from "./schema.ts";
import { type TakeoverRecord, isTakeoverRecord } from "./takeover.ts";

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
  verifiedSha?: string;
}

export interface LedgerDriver {
  /** The working tree driving (`resolveActor`). */
  actor: string;
  /** The account its pass bills, hashed; `null` when unknown. */
  account: string | null;
  /** The clone, by machine and state directory: two clones never share one. */
  clone: string;
  /** When this ledger was written: the driver's heartbeat across clones. */
  heartbeat: string;
  /** `stopped` once the driver has exited, with its exit code. */
  state: "running" | "stopped";
  exit?: number;
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
  phase: string;
  lastCountedHead: string;
  verifiedSha: string;
  readyMarkedRound: number;
  parked: ParkedItem[];
  held: LedgerHeld[];
  quotaPark: QuotaParkRecord | null;
  takeovers: TakeoverRecord[];
  claims: LedgerClaimRef[];
  /** Decisions taken unattended; empty until the autonomy levels record them. */
  decisions: unknown[];
  driver: LedgerDriver;
  /** The handoff narrative's last lines. */
  narrative: string[];
  /** What the size cut dropped from this body, in order. */
  cut: string[];
}

export type ParsedLedger =
  | { kind: "ledger"; ledger: Ledger }
  | { kind: "unknown-version"; version: unknown }
  | { kind: "malformed"; reason: string };

export interface TakeoverClaim {
  actor: string;
  account: string | null;
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
    phase: s.phase,
    lastCountedHead: s.lastCountedHead,
    verifiedSha: s.verifiedSha,
    readyMarkedRound: s.readyMarkedRound,
    parked: s.parked,
    held: s.held.map(ledgerHeld),
    quotaPark: s.quotaPark,
    takeovers: s.takeovers ?? [],
    claims: opts.claims,
    decisions: [],
    driver: opts.driver,
    narrative: opts.narrative.slice(-NARRATIVE_LINES),
    cut: [],
  };
}

function ledgerHeld(h: HeldItem): LedgerHeld {
  return {
    key: h.key,
    kind: h.kind,
    round: h.round,
    actor: h.actor,
    outcome: h.outcome,
    ...(h.commentUrl === undefined ? {} : { commentUrl: h.commentUrl }),
    ...(h.verifiedSha === undefined ? {} : { verifiedSha: h.verifiedSha }),
  };
}

/** JSON with every `<` and `>` escaped, so it cannot close an HTML comment. */
function commentSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
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
    `Round ${l.round}, phase \`${l.phase === "" ? "unset" : l.phase}\` · driver \`${d.actor}\` ${d.state === "running" ? "running" : `stopped (exit ${d.exit ?? "?"})`}, last heartbeat ${d.heartbeat} · ${l.parked.length} parked, ${l.held.length} held, ${l.takeovers.length} takeover(s)`,
  ];
  if (parkedList && l.parked.length > 0) {
    lines.push("", "Parked, awaiting a person:");
    for (const p of l.parked)
      lines.push(
        `- \`${p.key}\` (${p.kind}, round ${p.round}): ${summaryText(p.reason)}`,
      );
  }
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
    held: l.held.map(({ outcome: _dropped, ...rest }) => rest),
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

function isLedgerHeld(v: unknown): v is LedgerHeld {
  return (
    isRecord(v) &&
    isText(v.key) &&
    v.key !== "" &&
    (v.kind === "thread" || v.kind === "finding") &&
    isCount(v.round) &&
    isText(v.actor) &&
    (v.outcome === undefined ||
      v.outcome === "accepted" ||
      v.outcome === "moot") &&
    (v.commentUrl === undefined || isText(v.commentUrl)) &&
    (v.verifiedSha === undefined || isText(v.verifiedSha))
  );
}

function isLedgerDriver(v: unknown): v is LedgerDriver {
  return (
    isRecord(v) &&
    isText(v.actor) &&
    (v.account === null || isAccountHash(v.account)) &&
    isText(v.clone) &&
    isText(v.heartbeat) &&
    Number.isFinite(Date.parse(v.heartbeat)) &&
    (v.state === "running" || v.state === "stopped") &&
    (v.exit === undefined || isCount(v.exit))
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
    ["phase", isText(v.phase)],
    ["lastCountedHead", isText(v.lastCountedHead)],
    ["verifiedSha", isText(v.verifiedSha)],
    ["readyMarkedRound", isCount(v.readyMarkedRound)],
    ["parked", Array.isArray(v.parked)],
    ["held", Array.isArray(v.held) && v.held.every(isLedgerHeld)],
    ["quotaPark", v.quotaPark === null || isRecord(v.quotaPark)],
    [
      "takeovers",
      Array.isArray(v.takeovers) && v.takeovers.every(isTakeoverRecord),
    ],
    ["claims", Array.isArray(v.claims) && v.claims.every(isClaimRef)],
    ["decisions", Array.isArray(v.decisions)],
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
  if (data.ledgerVersion !== LEDGER_VERSION)
    return { kind: "unknown-version", version: data.ledgerVersion };
  const fault = ledgerFault(data);
  if (fault !== "")
    return { kind: "malformed", reason: `ill-formed field(s): ${fault}` };
  return { kind: "ledger", ledger: data as unknown as Ledger };
}

/** The append-only takeover claim's comment body. */
export function renderClaim(claim: TakeoverClaim): string {
  return [
    CLAIM_MARKER,
    `**Drive takeover claim** · \`drive-pr-takeover-claim\` · the drive of this pull request is taken over by another clone, from a driver whose ledger heartbeat is older than the lease window. Of the claims on one ledger generation the earliest wins; a driver that finds a newer claim than its own stops at its next round boundary.`,
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
    !(v.account === null || isAccountHash(v.account)) ||
    !isText(v.clone) ||
    !isCount(v.generation) ||
    !isText(v.at)
  )
    return null;
  return {
    actor: v.actor,
    account: v.account as string | null,
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
  /** The lowest-id trusted ledger comment, and what it parses to. */
  canonical: { comment: ForgeComment; parsed: ParsedLedger } | null;
  /** Every other trusted ledger comment: a lost creation race. */
  duplicates: ForgeComment[];
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

export function snapshotFrom(
  comments: readonly ForgeComment[],
  selfLogin: string | null,
): LedgerSnapshot {
  const sorted = [...comments].sort((a, b) => a.id - b.id);
  const ledgers: ForgeComment[] = [];
  const untrusted: ForgeComment[] = [];
  const claims: ClaimComment[] = [];
  let maxGeneration = 0;
  for (const c of sorted) {
    const isLedger = opensWith(c.body, LEDGER_MARKER);
    const isClaim = opensWith(c.body, CLAIM_MARKER);
    if (!isLedger && !isClaim) continue;
    if (!isTrusted(c, selfLogin)) {
      untrusted.push(c);
      continue;
    }
    if (isClaim) {
      const claim = parseClaim(c.body);
      if (claim !== null) claims.push({ id: c.id, claim });
      continue;
    }
    ledgers.push(c);
    const parsed = parseLedger(c.body);
    if (parsed?.kind === "ledger")
      maxGeneration = Math.max(maxGeneration, parsed.ledger.generation);
  }
  const [first, ...rest] = ledgers;
  return {
    canonical:
      first === undefined
        ? null
        : {
            comment: first,
            parsed: parseLedger(first.body) ?? {
              kind: "malformed",
              reason: "no marker",
            },
          },
    duplicates: rest,
    untrusted,
    claims,
    maxGeneration,
  };
}

/**
 * The claims in force: of the claims on one ledger generation, the earliest
 * (lowest id) wins and every later one has stood down, so it counts for
 * nothing.
 */
export function effectiveClaims(
  claims: readonly ClaimComment[],
): ClaimComment[] {
  const byGeneration = new Map<number, ClaimComment>();
  for (const c of [...claims].sort((a, b) => a.id - b.id))
    if (!byGeneration.has(c.claim.generation))
      byGeneration.set(c.claim.generation, c);
  return [...byGeneration.values()].sort((a, b) => a.id - b.id);
}

/**
 * The claim that ends this driver's drive: one in force, from another
 * clone, newer than `floor` (this driver's own claim, or the newest claim
 * in force when it started). `own` is this driver's own claim, counted
 * whether or not the listing shows it yet, so a rival it beat never reads
 * as in force.
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
  return (
    effectiveClaims(all).find(
      (c) => c.id > floor && c.claim.clone !== ownClone,
    ) ?? null
  );
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
    if (h.outcome === undefined) {
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
      ...(h.verifiedSha === undefined ? {} : { verifiedSha: h.verifiedSha }),
    });
  }
  return { held: out, dropped };
}

/**
 * `local` with the ledger's resumable subset laid over it. `dropped` names
 * the held items the size cut left without an outcome: they are not held
 * here, and the round triages them afresh. An `error` when the result is not
 * a usable state, so a ledger can never seed a state the store would refuse.
 */
export function seedFromLedger(
  local: DriveState,
  l: Ledger,
): { state: DriveState; dropped: string[] } | { error: string } {
  const { held, dropped } = heldFromLedger(l.held);
  const state: DriveState = {
    ...local,
    rounds: l.round,
    phase: l.phase,
    lastCountedHead: l.lastCountedHead,
    verifiedSha: l.verifiedSha,
    readyMarkedRound: l.readyMarkedRound,
    parked: l.parked,
    held,
    quotaPark: l.quotaPark,
    takeovers: l.takeovers,
    ledgerGeneration: l.generation,
  };
  if (!isUsableState(state, local.pr))
    return {
      error: `the ledger (generation ${l.generation}) does not describe a usable drive state`,
    };
  return { state, dropped };
}
