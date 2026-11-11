/**
 * The drive ledger: the drive state's resumable subset, mirrored into one
 * hidden-marker comment on the pull request, so a drive started in another
 * clone, on another machine, resumes where the last driver left off instead
 * of at round zero.
 *
 * This module is the pure half: the ledger's shape, how it is rendered into
 * a comment body within the forge's size limit and parsed back, the
 * append-only takeover claim (a claim of the shared forge-claims module,
 * `shared/records/forge-claims.ts`), which comments are trusted, and how a
 * ledger seeds a clone's state. `ledger-forge.ts` reads and writes the comments;
 * `ledger-mirror.ts` writes the ledger from the state at each round boundary,
 * park and takeover; `lib/driver/ledger.ts` seeds, admits and arbitrates.
 *
 * The comment opens with `<!-- drive-pr-ledger -->`, carries a short summary
 * a person can read on the pull request, and holds the data as JSON inside a
 * second HTML comment, written by the records codec
 * (`shared/records/envelope.ts`): the record envelope (kind `drive-ledger`,
 * its version, the pull request as its key, the writer and the time) beside
 * the ledger's own fields, with every `<` and `>` escaped. The data keeps its
 * own `ledgerVersion` beside the envelope's `v`, so a reader written before
 * the envelope still reads it, and a ledger written before the envelope (no
 * `kind`, `ledgerVersion: 1`) still reads here.
 *
 * A ledger or a claim is trusted only when its author is the drive's own
 * login or carries the owner, member or collaborator association GitHub
 * computes from repository permissions (`shared/trusted-authors.ts`); any
 * other comment opening with a marker is ignored and reported. When two
 * creations race, the lower comment id is canonical.
 */
import { isRecord } from "../../../../../shared/guards.ts";
import { redact, redactStrings } from "../../../../../shared/redact.ts";
export { redact, redactStrings } from "../../../../../shared/redact.ts";
import { failed, ok, type Outcome } from "../../../../../shared/outcome.ts";
import {
  encode,
  markerText,
  readEnvelope,
} from "../../../../../shared/records/envelope.ts";
import {
  arbitrate,
  type Claim,
  type ClaimKind,
  type ClaimRecord,
  type ClaimRule,
  claimBody,
  readClaim,
} from "../../../../../shared/records/forge-claims.ts";
import {
  localWriter,
  type Writer,
} from "../../../../../shared/records/writer.ts";
import { isTrustedAuthor } from "../../../../../shared/trusted-authors.ts";
import { stallThresholdMs } from "../doctor.ts";
import {
  type DriveState,
  type HeldItem,
  type ParkedItem,
  type QuotaParkRecord,
  isParkedItem,
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
import {
  isOptionalResolvedParks,
  redactedReceipt,
  type ResolutionReceipt,
} from "./resolution-receipt.ts";
import { decisionAnswerLines } from "./park-frame.ts";

export const LEDGER_MARKER = "<!-- drive-pr-ledger -->";
export const CLAIM_MARKER = "<!-- drive-pr-takeover-claim -->";
const LEDGER_DATA = "drive-pr-ledger-data";
const CLAIM_DATA = "drive-pr-takeover-claim-data";

/** The ledger's kind in the records registry (`shared/records/registry.ts`). */
export const LEDGER_KIND = "drive-ledger";

/** The ledger shape this version reads and writes: the envelope's `v`, and `ledgerVersion` beside it. */
export const LEDGER_VERSION = 1;
const OPERATOR_STOP_LEDGER_VERSION = 2;

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
  /** Explicit operator stop, preserved when a forced termination has no exit. */
  personStop?: { at: string; reason: string };
  /** This writer distinguishes operator stops from accidental no-exit stops. */
  recoveryVersion?: 1;
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
  /** The resolution receipts of the parks re-arms unparked (`resolution-receipt.ts`); absent in a ledger written before them. */
  resolvedParks?: ResolutionReceipt[];
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
      ...(p.decision === undefined
        ? {}
        : { decision: redactStrings(p.decision) }),
    })),
    held: s.held.map(ledgerHeld),
    quotaPark: withoutAccount(s.quotaPark),
    // A local tree's path stays on its machine, as the accounts do.
    takeovers: (s.takeovers ?? []).map(
      ({ fromAccount: _from, toAccount: _to, vanishedTree: _tree, ...t }) => t,
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
    resolvedParks: (s.resolvedParks ?? []).map(redactedReceipt),
    driver: opts.driver,
    narrative: opts.narrative.slice(-NARRATIVE_LINES).map(redact),
    cut: s.resolvedParksLost === true ? [OLDER_PARKS_CUT] : [],
  };
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

/**
 * The ledger's data block: the record envelope, with the pull request as its
 * key, the heartbeat as its time and the ledger's generation as its own,
 * beside the rest of the ledger's fields.
 */
function ledgerData(l: Ledger, writer: Writer): string {
  const { generation, ...fields } = l;
  return encode(
    {
      kind: LEDGER_KIND,
      v: l.ledgerVersion,
      key: String(l.pr),
      writer,
      at: l.driver.heartbeat,
      generation,
    },
    { ...fields },
  );
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

function stopSummary(
  stop: NonNullable<LedgerDriver["personStop"]>,
  state: LedgerDriver["state"],
): string {
  return `${state === "running" ? "Stop requested" : "Stopped"} by a person at ${stop.at}${stop.reason === "" ? "" : `: ${summaryText(stop.reason)}`}.`;
}

function ledgerBody(l: Ledger, parkedList: boolean, writer: Writer): string {
  const d = l.driver;
  const lines = [
    LEDGER_MARKER,
    `**Drive ledger** · \`drive-pr-ledger\` v${l.ledgerVersion} · generation ${l.generation}. Written by the drive at each round boundary, park and takeover; an edit here is overwritten.`,
    "",
    `Round ${l.round}, phase \`${l.phase === "" ? "unset" : l.phase}\` · driver \`${d.actor}\` ${d.state === "running" ? "running" : `stopped${d.exit === undefined ? "" : ` (exit ${d.exit})`}`}, last heartbeat ${d.heartbeat} · ${l.parked.length} parked, ${l.held.length} held, ${l.takeovers.length} takeover(s)`,
  ];
  if (d.personStop !== undefined)
    lines.push("", stopSummary(d.personStop, d.state));
  if (parkedList && l.parked.length > 0) {
    lines.push("", "Parked, awaiting a person:");
    for (const p of l.parked)
      lines.push(
        `- \`${p.key}\` (${p.kind}, ${p.class ?? "no class"}, round ${p.round}${p.digest === undefined ? "" : `, framing ${p.digest}`}): ${summaryText(p.reason)}`,
        ...decisionAnswerLines(p).map((line) => `  ${line}`),
      );
  }
  if (l.decisions.length > 0)
    lines.push("", ...decisionsSection(l.decisions).map(summaryLine));
  if (l.cut.length > 0)
    lines.push(
      "",
      `Cut to the forge's size limit: ${l.cut.join(", ")} dropped.`,
    );
  lines.push("", `<!-- ${LEDGER_DATA}`, ledgerData(l, writer), "-->");
  return `${lines.join("\n")}\n`;
}

function bytes(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** What `cut` names when the size cut dropped receipts: all of them, or the older ones. Readers treat either as an incomplete read of the receipts. */
export const RESOLVED_PARKS_CUT = "the resolved parks";
export const OLDER_PARKS_CUT = "the older resolved parks";

/**
 * The comment body for `ledger`, cut to `limit`: the resolved parks' receipts
 * go first, held items' outcomes next, the narrative then, and last the
 * visible list of parked decisions
 * (the data keeps every one). A parked decision is never dropped, so a body
 * that still does not fit is an error, not a smaller ledger. `writer` is the
 * envelope's: this process, with the forge login where the caller knows it.
 */
export function renderLedger(
  ledger: Ledger,
  limit = FORGE_BODY_LIMIT,
  writer: Writer = localWriter("forge"),
): { body: string; ledger: Ledger } | { error: string } {
  let l: Ledger = {
    ...ledger,
    ledgerVersion:
      ledger.driver.personStop === undefined
        ? ledger.ledgerVersion
        : OPERATOR_STOP_LEDGER_VERSION,
    // A receipt loss the state already carries stays named, whatever this render drops.
    cut: ledger.cut.filter(
      (c) => c === RESOLVED_PARKS_CUT || c === OLDER_PARKS_CUT,
    ),
  };
  let body = ledgerBody(l, true, writer);
  if (bytes(body) <= limit) return { body, ledger: l };
  const receipts = l.resolvedParks ?? [];
  // The oldest receipts go first: the newest are the ones no tick has read.
  for (let keep = receipts.length - 1; keep >= 0; keep--) {
    l = {
      ...l,
      resolvedParks: receipts.slice(receipts.length - keep),
      cut: [keep === 0 ? RESOLVED_PARKS_CUT : OLDER_PARKS_CUT],
    };
    body = ledgerBody(l, true, writer);
    if (bytes(body) <= limit) return { body, ledger: l };
  }
  l = {
    ...l,
    held: l.held.map(({ outcome: _dropped, reason: _answer, ...rest }) => rest),
    cut: [...l.cut, "held items' outcomes"],
  };
  body = ledgerBody(l, true, writer);
  if (bytes(body) <= limit) return { body, ledger: l };
  l = { ...l, narrative: [], cut: [...l.cut, "the narrative"] };
  body = ledgerBody(l, true, writer);
  if (bytes(body) <= limit) return { body, ledger: l };
  l = { ...l, cut: [...l.cut, "the visible list of parked decisions"] };
  body = ledgerBody(l, false, writer);
  if (bytes(body) <= limit) return { body, ledger: l };
  return {
    error: `the parked decisions alone need ${bytes(body)} bytes, exceeding the forge's ${limit}-byte comment limit; the ledger was not written`,
  };
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

function isRecoveryFields(v: Record<string, unknown>): boolean {
  if (v.recoveryVersion !== undefined && v.recoveryVersion !== 1) return false;
  if (v.personStop === undefined) return true;
  return (
    isRecord(v.personStop) &&
    isText(v.personStop.at) &&
    Number.isFinite(Date.parse(v.personStop.at)) &&
    isText(v.personStop.reason)
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
    isRecoveryFields(v) &&
    (v.started === undefined ||
      (isText(v.started) && Number.isFinite(Date.parse(v.started)))) &&
    (v.position === undefined || isCount(v.position))
  );
}

function isClaimRef(v: unknown): v is LedgerClaimRef {
  return (
    isRecord(v) && isCount(v.id) && isText(v.clone) && isCount(v.generation)
  );
}

/** The fields of a version-1 ledger, each checked; `''` when all hold. */
function isParkedList(v: unknown): boolean {
  return Array.isArray(v) && v.every(isParkedItem);
}

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
    ["parked", isParkedList(v.parked)],
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
    ["resolvedParks", isOptionalResolvedParks(v.resolvedParks)],
    ["driver", isLedgerDriver(v.driver)],
    ["narrative", Array.isArray(v.narrative) && v.narrative.every(isText)],
    ["cut", Array.isArray(v.cut) && v.cut.every(isText)],
  ];
  return checks
    .filter(([, ok]) => !ok)
    .map(([name]) => name)
    .join(", ");
}

type LedgerFields = { fields: Record<string, unknown> } | ParsedLedger;

const malformed = (reason: string): ParsedLedger => ({
  kind: "malformed",
  reason,
});

/** The fields of a ledger written with the envelope, its generation the envelope's. */
function envelopedFields(data: Record<string, unknown>): LedgerFields {
  const read = readEnvelope(data, LEDGER_KIND);
  if (!read.ok)
    return read.failure.code === "newer-version"
      ? { kind: "unknown-version", version: data.v }
      : malformed(read.failure.reason);
  const { envelope, payload } = read.value;
  if (data.ledgerVersion !== undefined && data.ledgerVersion !== envelope.v)
    return malformed(
      `ledgerVersion ${JSON.stringify(data.ledgerVersion)} is not the envelope's version ${envelope.v}`,
    );
  if (envelope.key !== String(payload.pr))
    return malformed(
      `the envelope's key ${envelope.key} names another pull request`,
    );
  const { v, generation } = envelope;
  return { fields: { ...payload, ledgerVersion: v, generation } };
}

/**
 * The ledger's fields in a data block: an enveloped ledger's, or those of a
 * ledger written before the envelope, which `ledgerVersion` alone versions.
 * A newer `ledgerVersion` or envelope version reads as a future ledger,
 * whichever form carries it; any other version is damage.
 */
function ledgerFields(data: Record<string, unknown>): LedgerFields {
  const version = data.ledgerVersion;
  if (isCount(version) && version > OPERATOR_STOP_LEDGER_VERSION)
    return { kind: "unknown-version", version };
  if ("kind" in data) return envelopedFields(data);
  return version === LEDGER_VERSION || version === OPERATOR_STOP_LEDGER_VERSION
    ? { fields: data }
    : malformed(
        `ledgerVersion ${JSON.stringify(version) ?? "is missing"} is not a version`,
      );
}

/** Parse a ledger comment body; `null` when the body is not a ledger. */
export function parseLedger(body: string): ParsedLedger | null {
  if (!opensWith(body, LEDGER_MARKER)) return null;
  const raw = markerText(body, LEDGER_DATA);
  if (!raw.ok) return { kind: "malformed", reason: "no data block" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.value);
  } catch {
    return { kind: "malformed", reason: "the data block is not JSON" };
  }
  if (!isRecord(parsed))
    return { kind: "malformed", reason: "the data block is not an object" };
  const read = ledgerFields(parsed);
  if (!("fields" in read)) return read;
  const fault = ledgerFault(read.fields);
  if (fault !== "")
    return { kind: "malformed", reason: `ill-formed field(s): ${fault}` };
  return { kind: "ledger", ledger: read.fields as unknown as Ledger };
}

/** The takeover claim's key: the ledger generation its claimant read. */
export function takeoverKey(generation: number): string {
  return `takeover:${generation}`;
}

const CLAIM_TEXT =
  "**Drive claim** · `drive-pr-takeover-claim` · a driver in another clone claims the drive of this pull request: a takeover from a driver whose ledger heartbeat is older than the lease window, or a start where no driver of that clone held it. Of the claims on one ledger generation the earliest wins; a driver that finds a newer claim than its own stops at its next round boundary.";

/** Why a takeover claim's record is not one, or `null` when it is. */
function takeoverFault(r: ClaimRecord): string | null {
  const { actor, clone } = r.payload;
  if (!isText(actor) || !isText(clone)) return "it names no actor and clone";
  return isCount(r.generation) && r.key === takeoverKey(r.generation)
    ? null
    : `its key ${r.key} is not its generation's`;
}

/** A claim written before claims carried the envelope: its data block holds the claim alone. */
function legacyClaim(body: string): Outcome<ClaimRecord, "unreadable"> | null {
  const raw = markerText(body, CLAIM_DATA);
  if (!raw.ok) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw.value);
  } catch {
    return failed("unreadable", "a takeover claim's data is not JSON");
  }
  if (!isRecord(v) || !isCount(v.generation) || !isText(v.at)) return null;
  const record = {
    key: takeoverKey(v.generation),
    generation: v.generation,
    at: v.at,
    payload: { actor: v.actor, clone: v.clone },
    legacy: true,
  };
  return takeoverFault(record) === null ? ok(record) : null;
}

/**
 * The takeover claim as a kind of forge claim: the earliest trusted claim on
 * a ledger generation wins, and one made more than the lease window after a
 * winner whose owner never wrote the ledger replaces it (`claimRule`).
 */
export const TAKEOVER_CLAIM: ClaimKind = {
  name: "drive-takeover-claim",
  opens: CLAIM_MARKER,
  data: `<!-- ${CLAIM_DATA}`,
  shape: takeoverFault,
  legacy: legacyClaim,
};

/** The rule the takeover claims are decided by: the lease window is the lapse window. */
export function claimRule(): ClaimRule {
  return { lapseMs: stallThresholdMs() };
}

/** The append-only takeover claim's comment body. `writer` is the envelope's. */
export function renderClaim(
  claim: TakeoverClaim,
  writer: Writer = localWriter("forge"),
): string {
  return `${claimBody(TAKEOVER_CLAIM, {
    key: takeoverKey(claim.generation),
    generation: claim.generation,
    writer,
    at: claim.at,
    payload: { actor: claim.actor, clone: claim.clone },
    text: `\n${CLAIM_TEXT}`,
  })}\n`;
}

/** The takeover claim a read claim record is. */
export function takeoverOf(r: ClaimRecord): TakeoverClaim {
  return {
    actor: String(r.payload.actor),
    clone: String(r.payload.clone),
    generation: r.generation ?? 0,
    at: r.at,
  };
}

/** A trusted takeover claim the forge-claims module read, as the ledger carries it. */
export function claimComment(c: Claim): ClaimComment {
  return { id: c.id, claim: takeoverOf(c) };
}

export function parseClaim(body: string): TakeoverClaim | null {
  const read = readClaim(TAKEOVER_CLAIM, body);
  return read?.ok === true ? takeoverOf(read.value) : null;
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

function isTrusted(c: ForgeComment, selfLogin: string | null): boolean {
  return isTrustedAuthor(c.login, c.association, selfLogin);
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
 * The claims in force, by the forge-claims rule: of the claims on one ledger
 * generation, the earliest (lowest id) wins and every later one has stood
 * down, so it counts for nothing. A winner whose owner never wrote the ledger
 * past that generation is abandoned (its seeding failed, or it died before
 * its first write): a claim on the same generation posted more than the
 * lease window after it (`stallThresholdMs`) wins in its place, so an
 * abandoned claim never holds the drive for good.
 */
export function effectiveClaims(
  claims: readonly ClaimComment[],
): ClaimComment[] {
  const weighed = claims.map((c) => ({
    id: c.id,
    key: takeoverKey(c.claim.generation),
    generation: c.claim.generation,
    at: c.claim.at,
    comment: c,
  }));
  return arbitrate(weighed, claimRule()).map((c) => c.comment);
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
  allowStopped = false,
): { ledger: Ledger; own: ClaimComment | null } | { why: string } {
  const parsed = snapshot.canonical?.parsed;
  if (parsed?.kind !== "ledger") return { why: "there is no ledger to mark" };
  const d = parsed.ledger.driver;
  if (!mayMarkDriver(d, who, allowStopped))
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

/** An explicit stop may finish publication after its own driver already stopped. */
function mayMarkDriver(
  driver: LedgerDriver,
  who: StoppedDriver,
  allowStopped: boolean,
): boolean {
  if (driver.state === "running") return true;
  return allowStopped && who.started !== "" && driver.started === who.started;
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
    ...(l.resolvedParks === undefined
      ? {}
      : { resolvedParks: l.resolvedParks }),
    ...(l.cut.some((c) => c === RESOLVED_PARKS_CUT || c === OLDER_PARKS_CUT)
      ? { resolvedParksLost: true }
      : {}),
    ledgerGeneration: l.generation,
  };
  if (!isUsableState(state, local.pr))
    return {
      error: `the ledger (generation ${l.generation}) does not describe a usable drive state`,
    };
  return { state, dropped };
}
