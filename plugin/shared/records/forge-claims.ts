/**
 * Claims on the forge: the one module that posts, reads back and arbitrates
 * a claim comment on a pull request or issue. Jig makes three kinds of claim
 * there: a driver taking a drive over from another clone's stopped driver
 * (`drive-takeover-claim`), the dispatcher or a person following up a merge
 * (`dispatch-followup`), and a driver announcing that a head is safe to merge
 * (`drive-merge-ready`). Each kind is described by a `ClaimKind`; every one is
 * written, read and decided here.
 *
 * A claim comment opens with its kind's line, holds its record in the records
 * codec's marker form (`envelope.ts`), and ends with text a person reads:
 *
 *   <the kind's opening line>
 *   <!-- <the kind's data marker>
 *   {"kind":"…","v":1,"key":"…","writer":{…},"at":"…",…}
 *   -->
 *   <text for people>
 *
 * The envelope's `key` is what is claimed (`takeover:<generation>`,
 * `followup`, `merge-ready:<head>`), and `generation`, where the kind has one,
 * which round of it. A claim in a form written before this one (no envelope,
 * or an older version of the kind) is read through its kind's `legacy` reader.
 *
 * One rule decides between claims: of the trusted claims on one key and
 * generation, the earliest comment (the lowest id) wins. A rule may name a
 * lapse window, past which a later claim on the same key and generation
 * replaces a winner whose owner never acted on it (the takeover's lease
 * window). A comment counts only when the caller's own forge login wrote it
 * or the forge vouches for its author as an owner, member or collaborator
 * (`trusted-authors.ts`); any other is listed as untrusted and ignored.
 *
 * The forge offers no conditional create for a comment, and its listing can
 * lag behind a post, so a claim is a post followed by a read-back. When the
 * listing does not show the caller's own comment, the read is repeated a
 * bounded number of times with a delay, and the claim is then reported
 * `lost` rather than counted unseen. A caller re-checks its claim before each
 * act outside the pull request (`check`), and withdraws its own comment when
 * it lost (`withdraw`).
 *
 * What this cannot close: two posts whose read-backs each lag past the
 * other's comment both read themselves the winner, and a check that lags the
 * same way passes. The rule narrows that window to the read-back and each
 * later check; the earlier comment still wins at the first read that lists
 * both, and each kind says what its callers do then (a driver stands down at
 * its next round boundary, a follow-up stops before its next act and the
 * dispatcher reports two markers, a duplicate announcement is withdrawn).
 *
 * Every forge call goes through `ghCall` (`shared/proc.ts`), under its
 * deadline, and every operation returns an `Outcome`
 * ([ADR-0012](../../../docs/adr/ADR-0012-failures-as-values.md)): a forge or
 * parse failure is a value, never a throw.
 */
import { type Clock, systemClock } from "../clock.ts";
import { Defect } from "../errors.ts";
import { isRecord } from "../guards.ts";
import { failed, ok, type Outcome } from "../outcome.ts";
import { ghCall } from "../proc.ts";
import { isTrustedAuthor } from "../trusted-authors.ts";
import { encodeMarker, markerText, readEnvelope } from "./envelope.ts";
import { recordKind } from "./registry.ts";
import type { Writer } from "./writer.ts";

/** The pull request or issue a claim is made on. */
export interface ClaimTarget {
  /** `owner/name`, or `{owner}/{repo}` for the checkout's own repository, which `gh` fills in. */
  repo: string;
  number: number;
}

/** What one claim says. */
export interface ClaimRecord {
  key: string;
  generation?: number;
  /** When it was made, as an ISO 8601 time; a claim in an earlier form may carry none (`""`). */
  at: string;
  /** Who made it; absent on a claim written before claims carried the envelope. */
  writer?: Writer;
  /** The kind's own fields: data, never a command. */
  payload: Record<string, unknown>;
  /** Read through the kind's `legacy` reader. */
  legacy: boolean;
}

/** How one kind of claim is written and read. */
export interface ClaimKind {
  /** Its name in the records registry, whose version it is written in. */
  name: string;
  /** The line its comment opens with: a comment that does not open with it is no claim of this kind. */
  opens: string;
  /** The opening of the hidden marker its record is written in: `<!-- <name>`. */
  data: string;
  /**
   * The one key the kind claims on each pull request, where it has only one
   * (the follow-up's). A trusted comment of such a kind whose record does not
   * read is taken to claim that key: it holds against every later claim, and
   * a person settles it.
   */
  onlyKey?: string;
  /**
   * Why a record that reads is still not a claim of this kind (its key or
   * payload has the wrong shape, or it names another pull request than
   * `target`), or `null` when it is one.
   */
  shape?: (record: ClaimRecord, target: ClaimTarget | null) => string | null;
  /**
   * A claim in a form written before this one: what it says, why it does not
   * read, or `null` when the body is in no form the kind knows.
   */
  legacy?: (
    body: string,
    target: ClaimTarget | null,
  ) => Outcome<ClaimRecord, "unreadable"> | null;
}

/** One comment opening as a claim of a kind, as the forge lists it. */
export interface ListedClaim {
  id: number;
  login: string;
  association: string;
  createdAt: string;
  /** Written by the caller's own login, or by an author the forge vouches for. */
  trusted: boolean;
  /** What it claims, or why its record does not read. */
  record: Outcome<ClaimRecord, "unreadable">;
}

/** A trusted claim, as the rule weighs it. */
export interface Claim extends ClaimRecord {
  id: number;
  login: string;
  createdAt: string;
  /** Set on a trusted comment of a one-key kind whose record does not read: why. It still claims that key. */
  unreadable?: string;
}

/** What `arbitrate` needs of a claim. */
export interface Arbitrable {
  id: number;
  key: string;
  generation?: number;
  at: string;
}

/** The rule's settings for one kind. */
export interface ClaimRule {
  /** A winner lapses when a later claim on its key and generation was made more than this many milliseconds after it. */
  lapseMs?: number;
  /** How many more reads a read-back makes while the listing does not show the caller's own comment. */
  retries?: number;
  /** The wait before each of those reads, in milliseconds. */
  delayMs?: number;
}

/** A claim to post. */
export interface ClaimDraft {
  key: string;
  generation?: number;
  writer: Writer;
  /** When it is made; now when absent. */
  at?: string;
  payload: Record<string, unknown>;
  /** What a person reads, after the record. */
  text: string;
}

/** A claim as its poster made it: what the read-back weighs it as when the listing does not show it. */
export type Posted = Arbitrable;

/** How the caller's claim stands after a read. */
export interface Standing {
  /**
   * `holds`: the caller's own claim wins its key and generation; `lost-to`:
   * another claim does (`winner`); `lost`: the caller holds nothing and no
   * one beat it, because its comment is not listed or no longer reads as a
   * claim on the key (`reason`).
   */
  verdict: "holds" | "lost-to" | "lost";
  /** The claim that holds the key: the caller's own, or the one it lost to. */
  winner: Claim | null;
  /** The caller's own comment as the read lists it, trusted or not; `null` when it is not listed. */
  own: ListedClaim | null;
  reason: string;
  /** Every comment of the kind the read listed, earliest first. */
  listing: ListedClaim[];
}

/** The settings a read takes: the caller's own login, the rule, and a clock for the read-back's waits. */
export interface ReadOptions {
  self?: string | null;
  rule?: ClaimRule;
  clock?: Pick<Clock, "sleep">;
}

/** How often, and how long apart, a read-back reads again by default. */
const RETRIES = 3;
const DELAY_MS = 2_000;

const dataName = (kind: ClaimKind): string => kind.data.replace(/^<!--\s*/, "");

/** The schema version `kind` is written in, from the registry. */
function versionOf(kind: ClaimKind): number {
  const registered = recordKind(kind.name);
  if (registered === undefined || registered.key === undefined)
    throw new Defect(`${kind.name} is not a registered claim kind`);
  return registered.version;
}

/** A draft with its time fixed: now, when it named none. */
function stamped(draft: ClaimDraft): ClaimDraft & { at: string } {
  return { ...draft, at: draft.at ?? new Date().toISOString() };
}

/** The comment body for `draft`. A draft that breaks the envelope's strict form is a defect, and throws. */
export function claimBody(kind: ClaimKind, draft: ClaimDraft): string {
  const { key, generation, writer, at, payload, text } = stamped(draft);
  const envelope = {
    kind: kind.name,
    v: versionOf(kind),
    key,
    writer,
    at,
    ...(generation === undefined ? {} : { generation }),
  };
  return [kind.opens, encodeMarker(dataName(kind), envelope, payload), text]
    .join("\n")
    .trimEnd();
}

/** Whether `body` opens with the kind's line; a quotation of it mid-body does not. */
function opensAs(kind: ClaimKind, body: string): boolean {
  return body.replaceAll("\r", "").trimStart().startsWith(kind.opens);
}

/**
 * The record in a claim's data block when it is in this version's form;
 * `null` when it is in an earlier form (no envelope, or an older version).
 */
function currentRecord(
  kind: ClaimKind,
  json: string,
): Outcome<ClaimRecord, "unreadable"> | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return failed("unreadable", "its record is not JSON");
  }
  if (!isRecord(value) || !("kind" in value)) return null;
  const read = readEnvelope(value, kind.name);
  if (!read.ok)
    return failed(
      "unreadable",
      `its record does not read: ${read.failure.reason}`,
    );
  const { envelope, payload } = read.value;
  if (envelope.v < versionOf(kind)) return null;
  return ok({
    key: envelope.key,
    ...(envelope.generation === undefined
      ? {}
      : { generation: envelope.generation }),
    at: envelope.at,
    writer: envelope.writer,
    payload,
    legacy: false,
  });
}

/**
 * What a comment claims: its record, why it does not read, or `null` when it
 * does not open as a claim of `kind`. `target` is the pull request it was read
 * on, for a legacy form that names one.
 */
export function readClaim(
  kind: ClaimKind,
  body: string,
  target: ClaimTarget | null = null,
): Outcome<ClaimRecord, "unreadable"> | null {
  if (!opensAs(kind, body)) return null;
  const text = body.replaceAll("\r", "");
  const data = markerText(text, dataName(kind));
  const read =
    (data.ok ? currentRecord(kind, data.value) : null) ??
    kind.legacy?.(text, target) ??
    failed("unreadable", `it does not read as a ${kind.name} claim`);
  const fault = read.ok ? (kind.shape?.(read.value, target) ?? null) : null;
  return fault === null ? read : failed("unreadable", fault);
}

/**
 * The winners under the rule: of the claims on each key and generation, the
 * earliest comment, unless a later claim on it was made more than the lapse
 * window after it, which then wins in its place. Earliest first.
 */
export function arbitrate<T extends Arbitrable>(
  claims: readonly T[],
  rule: Pick<ClaimRule, "lapseMs"> = {},
): T[] {
  const winners = new Map<string, T>();
  for (const c of [...claims].sort((a, b) => a.id - b.id)) {
    const group = `${c.key}\n${c.generation ?? ""}`;
    const winner = winners.get(group);
    if (winner === undefined || lapsed(winner, c, rule.lapseMs))
      winners.set(group, c);
  }
  return [...winners.values()].sort((a, b) => a.id - b.id);
}

function lapsed(winner: Arbitrable, later: Arbitrable, lapseMs?: number) {
  return (
    lapseMs !== undefined &&
    Date.parse(later.at) - Date.parse(winner.at) > lapseMs
  );
}

/** A listed comment as the rule weighs it, or `null` when it does not claim anything it can weigh. */
function weighed(kind: ClaimKind, c: ListedClaim): Claim | null {
  if (!c.trusted) return null;
  const who = { id: c.id, login: c.login, createdAt: c.createdAt };
  if (c.record.ok) return { ...c.record.value, ...who };
  if (kind.onlyKey === undefined) return null;
  return {
    ...who,
    key: kind.onlyKey,
    at: c.createdAt,
    payload: {},
    legacy: false,
    unreadable: c.record.failure.reason,
  };
}

/** The trusted claims of a listing on `key` (and `generation`, where given), earliest first. */
function claimsOn(
  kind: ClaimKind,
  listing: readonly ListedClaim[],
  key: string,
  generation?: number,
): Claim[] {
  return listing
    .map((c) => weighed(kind, c))
    .filter(
      (c): c is Claim =>
        c !== null &&
        c.key === key &&
        (generation === undefined || c.generation === generation),
    );
}

/** One `gh` call's output, or why it failed. */
async function gh(
  args: string[],
  stdin?: string,
): Promise<Outcome<string, "forge">> {
  const r = await ghCall(args, {
    stderr: "pipe",
    ...(stdin === undefined ? {} : { stdin }),
  });
  if (r.code === 0) return ok(r.stdout);
  const last = r.stderr.trim().split("\n").at(-1) ?? "";
  return failed(
    "forge",
    [`gh exited ${r.code}`, last].filter(Boolean).join(": "),
  );
}

const textOf = (v: unknown): string => (typeof v === "string" ? v : "");

/** One comment of a listing page, when it opens as a claim of `kind`. */
function listed(
  kind: ClaimKind,
  c: unknown,
  target: ClaimTarget,
  self: string | null,
): ListedClaim | null {
  if (!isRecord(c) || typeof c.id !== "number") return null;
  const record = readClaim(kind, textOf(c.body), target);
  if (record === null) return null;
  const login = isRecord(c.user) ? textOf(c.user.login) : "";
  const association = textOf(c.author_association);
  return {
    id: c.id,
    login,
    association,
    createdAt: textOf(c.created_at),
    trusted: isTrustedAuthor(login, association, self),
    record,
  };
}

/** The comments of `--paginate --slurp` pages, or why they are not a listing. */
function pagesOf(stdout: string): Outcome<unknown[], "unreadable"> {
  let pages: unknown;
  try {
    pages = JSON.parse(stdout);
  } catch {
    return failed("unreadable", "the comment listing is not JSON");
  }
  const all = Array.isArray(pages) ? pages : [pages];
  if (!all.every(Array.isArray))
    return failed("unreadable", "the comment listing is not a list");
  return ok(all.flat());
}

/** Every comment on `target` that opens as a claim of `kind`, trusted or not, earliest first; or why they could not be read. */
export async function list(
  target: ClaimTarget,
  kind: ClaimKind,
  self: string | null = null,
): Promise<Outcome<ListedClaim[], "unreadable">> {
  const r = await gh([
    "api",
    "--paginate",
    "--slurp",
    `repos/${target.repo}/issues/${target.number}/comments?per_page=100`,
  ]);
  if (!r.ok)
    return failed(
      "unreadable",
      `the comments could not be read (${r.failure.reason})`,
    );
  const comments = pagesOf(r.value);
  if (!comments.ok) return comments;
  return ok(
    comments.value
      .map((c) => listed(kind, c, target, self))
      .filter((c): c is ListedClaim => c !== null)
      .sort((a, b) => a.id - b.id),
  );
}

/** The trusted claims on `key` (and `generation`, where given), earliest first; or why they could not be read. */
export async function read(
  target: ClaimTarget,
  kind: ClaimKind,
  key: string,
  opts: ReadOptions & { generation?: number } = {},
): Promise<Outcome<Claim[], "unreadable">> {
  const listing = await list(target, kind, opts.self ?? null);
  return listing.ok
    ? ok(claimsOn(kind, listing.value, key, opts.generation))
    : listing;
}

/**
 * How the claim `posted` stands in `listing`. The rule weighs the caller's
 * claim as it was posted whether or not the listing shows it, so a claim
 * that beat it is seen at once; the caller holds the key only when the
 * listing shows its comment as a trusted claim on it.
 */
export function standing(
  kind: ClaimKind,
  listing: ListedClaim[],
  posted: Posted,
  rule: ClaimRule = {},
): Standing {
  const own = listing.find((c) => c.id === posted.id) ?? null;
  const rivals = claimsOn(kind, listing, posted.key, posted.generation);
  const mine = rivals.find((c) => c.id === posted.id) ?? null;
  const pool: Arbitrable[] = [
    ...rivals.filter((c) => c.id !== posted.id),
    mine ?? posted,
  ];
  const [first] = arbitrate(pool, rule);
  const beaten = rivals.find((c) => c.id === first?.id && c.id !== posted.id);
  const base = { own, listing, reason: "" };
  if (beaten !== undefined)
    return { ...base, verdict: "lost-to", winner: beaten };
  if (mine !== null) return { ...base, verdict: "holds", winner: mine };
  return {
    ...base,
    verdict: "lost",
    winner: null,
    reason:
      own === null
        ? `the listing does not show comment ${posted.id}`
        : `comment ${posted.id} no longer reads as a trusted ${kind.name} claim on ${posted.key}`,
  };
}

/**
 * Read the claims back after posting `posted`: how it stands, reading again
 * up to the rule's retries, its delay apart, while the listing does not show
 * the caller's comment and no other claim has beaten it. A read that fails
 * is why the standing is unknown.
 */
export async function readBack(
  target: ClaimTarget,
  kind: ClaimKind,
  posted: Posted,
  opts: ReadOptions = {},
): Promise<Outcome<Standing, "unreadable">> {
  const rule = opts.rule ?? {};
  const retries = rule.retries ?? RETRIES;
  const clock = opts.clock ?? systemClock;
  for (let attempt = 0; ; attempt++) {
    const listing = await list(target, kind, opts.self ?? null);
    if (!listing.ok) return listing;
    const now = standing(kind, listing.value, posted, rule);
    if (now.verdict !== "lost" || now.own !== null || attempt >= retries)
      return ok(now);
    await clock.sleep(rule.delayMs ?? DELAY_MS);
  }
}

/**
 * Why a post failed: `not-posted` when the forge refused it, `no-comment-id`
 * when it answered without naming the comment, which may then stand.
 */
export type PostCode = "not-posted" | "no-comment-id";

/** The id and address of a comment just posted, or that the forge did not name it. */
function postedComment(
  stdout: string,
): Outcome<{ id: number; url: string }, PostCode> {
  let posted: unknown;
  try {
    posted = JSON.parse(stdout);
  } catch {
    posted = null;
  }
  const id = isRecord(posted) ? posted.id : undefined;
  if (
    !isRecord(posted) ||
    typeof id !== "number" ||
    !Number.isSafeInteger(id) ||
    id <= 0
  )
    return failed(
      "no-comment-id",
      "the forge answered the post without a usable comment id",
    );
  return ok({ id, url: textOf(posted.html_url) });
}

/** A claim posted, before its read-back: its comment, and the claim the read-back weighs. */
export interface Published {
  id: number;
  url: string;
  posted: Posted;
}

/**
 * Post the claim `draft` as a comment on `target`, without reading it back:
 * for a caller with its own checks between the post and the read-back, which
 * it then makes with `readBack`. Every other caller uses `post`.
 */
export async function publish(
  target: ClaimTarget,
  kind: ClaimKind,
  draft: ClaimDraft,
): Promise<Outcome<Published, PostCode>> {
  const claim = stamped(draft);
  const r = await gh(
    [
      "api",
      `repos/${target.repo}/issues/${target.number}/comments`,
      "--input",
      "-",
    ],
    JSON.stringify({ body: claimBody(kind, claim) }),
  );
  if (!r.ok) return failed("not-posted", r.failure.reason);
  const comment = postedComment(r.value);
  if (!comment.ok) return comment;
  const { key, generation, at } = claim;
  return ok({
    ...comment.value,
    posted: {
      id: comment.value.id,
      key,
      at,
      ...(generation === undefined ? {} : { generation }),
    },
  });
}

/** A claim posted and read back: its comment, and how it stands or why that is unknown. */
export interface PostedClaim extends Published {
  standing: Outcome<Standing, "unreadable">;
}

/** Post the claim `draft` on `target` and read it back. */
export async function post(
  target: ClaimTarget,
  kind: ClaimKind,
  draft: ClaimDraft,
  opts: ReadOptions = {},
): Promise<Outcome<PostedClaim, PostCode>> {
  const published = await publish(target, kind, draft);
  if (!published.ok) return published;
  return ok({
    ...published.value,
    standing: await readBack(target, kind, published.value.posted, opts),
  });
}

/**
 * The re-read before an act outside the pull request: how the caller's claim,
 * comment `ownId` on `key` (and `generation`, where given), stands now. One
 * read: by now the listing shows a comment that still exists.
 */
export async function check(
  target: ClaimTarget,
  kind: ClaimKind,
  key: string,
  ownId: number,
  opts: ReadOptions & { generation?: number } = {},
): Promise<Outcome<Standing, "unreadable">> {
  const listing = await list(target, kind, opts.self ?? null);
  if (!listing.ok) return listing;
  const mine = claimsOn(kind, listing.value, key, opts.generation).find(
    (c) => c.id === ownId,
  );
  // A comment that is no claim on the key is weighed as one made when it was
  // posted, so a claim earlier than it is still reported as the winner.
  const posted: Posted = mine ?? {
    id: ownId,
    key,
    at: "",
    ...(opts.generation === undefined ? {} : { generation: opts.generation }),
  };
  return ok(standing(kind, listing.value, posted, opts.rule));
}

/** Delete the caller's own claim, comment `ownId` on `target`'s repository; or why it could not be. */
export async function withdraw(
  target: Pick<ClaimTarget, "repo">,
  ownId: number,
): Promise<Outcome<void, "not-withdrawn">> {
  const r = await gh([
    "api",
    "-X",
    "DELETE",
    `repos/${target.repo}/issues/comments/${ownId}`,
  ]);
  return r.ok ? ok(undefined) : failed("not-withdrawn", r.failure.reason);
}
