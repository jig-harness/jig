/**
 * Open blockers on a plain claim, and a person's recorded decision to start
 * ahead of them.
 *
 * An item with an open `blocked_by` relation waits on that blocker: one
 * whose state is not completed, canceled or duplicate, or one that cannot be
 * read, since an unreadable blocker is not known to be finished. An
 * interactive plain claim (`tracker.ts claim` with `JIG_LAUNCH` unset and
 * without a served or factory claim's options or `--work-batch`) refuses
 * such an item with nothing written (`"why": "blockers"`, the blockers and
 * the consequence statement in its JSON), as a served claim withholds it
 * (`served-claim.ts`). A dispatched claim reads no blockers here: the
 * dispatcher chose the item.
 *
 * A person who knowingly decides to start the work anyway passes
 * `--override-blockers "<reason>"` (`claim-options.ts` refuses it outside an
 * interactive session). It clears that refusal and a preflight refusal its
 * command tagged `kind: blockers` (`preflight.ts`), nothing else: every other
 * refusal of the claim still stands. Before the claim writes, the open
 * blockers and the consequence statement are printed on stderr; once the
 * claim lands, one comment on the item records the override, the label
 * `do_item.override_label` names is added where the repository sets one
 * (never removed by Jig), and with `do_item.claim_marker` the claim marker
 * carries the same facts (`claim-marker.ts`).
 *
 * Persistent records (the override comment and the claim marker) include a
 * blocker's title, state and assignee only when the tracker adapter proves
 * readers of the claimed item share visibility with the blocker
 * (`Tracker.sharesVisibility`); otherwise they keep only the blocker's key.
 * Each override attempt carries a stable attempt id in its hidden marker
 * (`<!-- jig:blocker-override {"attempt":"..."} -->`), and posting checks
 * existing trusted comments first so a lost response never causes a blind
 * duplicate comment.
 */
import { randomUUID } from "node:crypto";
import { OutboundError } from "../../../../shared/outbound/failure.ts";
import { oneLine } from "../../../../shared/repo-command.ts";
import type { ClaimResult } from "./claim.ts";
import type { MarkerOverride } from "./claim-marker.ts";
import { UsageError } from "./cli.ts";
import {
  type PoolIssue,
  type Tracker,
  TrackerRequestError,
} from "./tracker/port.ts";

/** The hidden marker each blocker-override comment carries for idempotency. */
export const OVERRIDE_MARKER = "jig:blocker-override";

const OVERRIDE_MARKER_LINE =
  /<!--\s*jig:blocker-override\s+(\{[^\n]*?\})\s*-->/g;

/** The state types in which a blocker no longer holds an item back. */
const FINISHED = ["completed", "canceled", "duplicate"];

/** Whether a blocker still holds its item back: open, or unreadable. */
export function blockerHolds(issue: PoolIssue | null): boolean {
  return issue === null || !FINISHED.includes(issue.state.type);
}

/** One open blocker as the claim read it; an unreadable one has only its key. */
export interface OpenBlocker {
  key: string;
  title: string | null;
  /** The tracker's name for its state; `null` when it could not be read. */
  state: string | null;
  assignee: string | null;
  /**
   * True when the tracker adapter proved readers of the claimed item can
   * also see this blocker; absent or false means persistent records keep
   * only `key` and redact its metadata.
   */
  sharedVisibility?: boolean;
}

/** What an override records: who started the item, why, and what it was started ahead of. */
export interface BlockerOverride {
  /** Stable id for this override attempt, carried in the comment marker for idempotent retries. */
  attempt?: string;
  reason: string;
  /** The tracker identity the claim acts as: in an interactive session, the person's. */
  person: string;
  blockers: OpenBlocker[];
  /** The preflight command's blocker refusal the override cleared, when it refused. */
  preflight?: string;
}

/** Whether the override comment landed, definitely did not, or cannot be confirmed safely. */
export type OverrideCommentOutcome =
  | { status: "posted"; posted: true; attempt: string; alreadyPresent?: true }
  | {
      status: "not_posted";
      posted: false;
      attempt: string;
      marker: string;
      reason: string;
    }
  | {
      status: "indeterminate";
      posted: false;
      attempt: string;
      marker: string;
      reason: string;
    };

/** What the claim's JSON says of an override, once the claim landed. */
export interface OverrideReport extends BlockerOverride {
  attempt: string;
  comment: OverrideCommentOutcome;
  label?:
    | { name: string; added: true }
    | { name: string; added: false; reason: string };
}

/** The one statement of what starting ahead of open blockers risks. */
export const OVERRIDE_CONSEQUENCE =
  "Starting ahead of open blockers: the work may depend on changes that do not exist yet or may still change, may need rework when they land, and may not be safe to merge before them.";

type BlockerTracker = Pick<
  Tracker,
  "listRelations" | "poolIssue" | "sharesVisibility"
>;

/** Text safe to display in a terminal or Markdown record. */
const plain = (text: string) =>
  text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trim();

/** The hidden marker line for one override attempt id. */
export function overrideMarkerLine(attempt: string): string {
  return `<!-- ${OVERRIDE_MARKER} ${JSON.stringify({ attempt: plain(attempt) })} -->`;
}

/** Every well-formed attempt id a comment body's override markers name. */
export function overrideAttemptsIn(body: string): string[] {
  const out: string[] = [];
  for (const match of body.matchAll(OVERRIDE_MARKER_LINE)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[1] as string);
    } catch {
      continue;
    }
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "attempt" in parsed &&
      typeof parsed.attempt === "string" &&
      plain(parsed.attempt) !== ""
    )
      out.push(plain(parsed.attempt));
  }
  return out;
}

/**
 * The single override attempt id a comment body carries, or `null` when the
 * body is not an override comment. A body that mentions `jig:blocker-override`
 * in a malformed or repeated marker is refused as usage so it never falls
 * back to a blind duplicate post.
 */
export function overrideAttemptInBody(body: string): string | null {
  if (!body.includes(OVERRIDE_MARKER)) return null;
  const attempts = overrideAttemptsIn(body);
  const unique = [...new Set(attempts)];
  if (attempts.length !== 1 || unique.length !== 1)
    throw new UsageError(
      `the comment body carries a malformed or repeated ${OVERRIDE_MARKER} marker; include one line of the form ${overrideMarkerLine("<attempt>")}`,
    );
  return unique[0] as string;
}

/** The item's open and unreadable blockers, in the order its relations list them. */
export async function openBlockers(
  tracker: BlockerTracker,
  key: string,
): Promise<OpenBlocker[]> {
  const out: OpenBlocker[] = [];
  for (const relation of await tracker.listRelations(key)) {
    if (relation.type !== "blocked_by") continue;
    const blocker = await tracker.poolIssue(relation.issue);
    if (!blockerHolds(blocker)) continue;
    const sharedVisibility =
      tracker.sharesVisibility?.(key, relation.issue) === true;
    out.push({
      key: relation.issue,
      title: blocker?.title ?? null,
      state: blocker?.state.name ?? null,
      assignee: blocker?.assignee?.name ?? null,
      sharedVisibility,
    });
  }
  return out;
}

const named = (b: OpenBlocker) =>
  b.state === null
    ? `${plain(b.key)} (unreadable)`
    : `${plain(b.key)} (${plain(b.state)})`;

/** The refusal of a plain claim of an item with open blockers: nothing was written. */
export function blockersRefusal(
  key: string,
  blockers: OpenBlocker[],
): ClaimResult {
  return {
    outcome: "refused",
    issue: key,
    why: "blockers",
    overridable: true,
    reason: `${plain(key)} waits on ${blockers.map(named).join(", ")}: a person may start it ahead of them with --override-blockers "<reason>"`,
    blockers,
    consequence: OVERRIDE_CONSEQUENCE,
  };
}

/** One line describing a blocker, for stderr and same-visibility comments. */
function blockerLine(b: OpenBlocker): string {
  if (b.state === null) return `${plain(b.key)}: could not be read`;
  const title = b.title === null ? "" : ` "${plain(oneLine(b.title))}"`;
  const who =
    b.assignee === null ? "unassigned" : `assigned to ${plain(b.assignee)}`;
  return `${plain(b.key)}${title}: ${plain(b.state)}, ${who}`;
}

/** One blocker bullet in a persistent comment: keep only the key when shared visibility is unverified. */
function persistentBlockerLine(b: OpenBlocker): string {
  return b.sharedVisibility === true ? blockerLine(b) : plain(b.key);
}

/** What the claim prints on stderr before an overridden claim writes. */
export function overrideStatement(
  key: string,
  override: BlockerOverride,
): string {
  return [
    `${plain(key)} will be claimed ahead of its blockers on ${plain(override.person)}'s decision: ${plain(override.reason)}`,
    ...override.blockers.map((b) => `  blocked by ${blockerLine(b)}`),
    ...(override.preflight === undefined
      ? []
      : [`  the repository's preflight check: ${plain(override.preflight)}`]),
    OVERRIDE_CONSEQUENCE,
  ].join("\n");
}

/** The comment that records the override on the item. */
export function overrideComment(
  key: string,
  override: BlockerOverride,
  attempt: string = override.attempt ?? randomUUID(),
): string {
  return [
    "## Blocker override",
    "",
    `${plain(override.person)} started ${plain(key)} ahead of its open blockers: ${plain(override.reason)}`,
    "",
    ...override.blockers.map((b) => `- ${persistentBlockerLine(b)}`),
    ...(override.preflight === undefined
      ? []
      : [
          `- the repository's preflight check refused the claim on blockers (its message is not recorded)`,
        ]),
    "",
    OVERRIDE_CONSEQUENCE,
    "",
    overrideMarkerLine(attempt),
    "",
  ].join("\n");
}

/** The claim marker's payload fields for an override: none without one. */
export function markerOverride(override: BlockerOverride | null): {
  override?: MarkerOverride;
} {
  if (override === null) return {};
  return {
    override: {
      ...(override.attempt === undefined ? {} : { attempt: override.attempt }),
      reason: override.reason,
      person: override.person,
      blockers: override.blockers.map((b) => ({
        key: b.key,
        state: b.sharedVisibility === true ? b.state : null,
      })),
      ...(override.preflight === undefined ? {} : { preflight: "blockers" }),
    },
  };
}

export type BlockerGate =
  | { refusal: ClaimResult }
  | { override: BlockerOverride | null };

export interface GateInput {
  /**
   * The claim reads blockers at all: a plain claim (no served or factory
   * claim's options, not a work-batch member's) in an interactive session
   * (`JIG_LAUNCH` unset). A dispatched claim leaves blockers to the
   * dispatcher, as before the gate existed.
   */
  applies: boolean;
  /** `--override-blockers`' reason, when the person gave one. */
  reason: string | undefined;
  /** The preflight command's blocker refusal the reason clears, when it refused. */
  preflight: string | null;
  /** The identity the override is recorded under, read only for an override. */
  person: () => Promise<string>;
  /**
   * The refusal the claim would meet before it writes whatever its blockers
   * (`claim.ts`'s `refusalBeforeWrite`), read only when it has open
   * blockers and no override, so a refusal is offered for override only
   * when the override could succeed.
   */
  admission: () => Promise<ClaimResult | null>;
  say?: (line: string) => void;
}

/**
 * Before the claim lock and any write: refuse an interactive plain claim of
 * an item with open blockers, unless the person overrides them, in which
 * case the blockers and the consequence are printed and the override
 * returned for the claim to record. A refusal the claim would meet anyway
 * (the item in progress, in `pr_open`, outside `do_item.claim_from`, or
 * someone else's) is returned instead of the blockers', so an overridable
 * refusal is one an override clears. A served or factory claim reads no
 * blockers here: it checks its own.
 */
export async function blockerGate(
  tracker: BlockerTracker,
  key: string,
  input: GateInput,
): Promise<BlockerGate> {
  if (!input.applies) return { override: null };
  const blockers = await openBlockers(tracker, key);
  if (input.reason === undefined) {
    if (blockers.length === 0) return { override: null };
    const anyway = await input.admission();
    return { refusal: anyway ?? blockersRefusal(key, blockers) };
  }
  if (blockers.length === 0 && input.preflight === null) {
    (input.say ?? console.error)(
      `${plain(key)} has no open blockers: --override-blockers overrides nothing, and the claim goes on as any other`,
    );
    return { override: null };
  }
  const override: BlockerOverride = {
    attempt: randomUUID(),
    reason: input.reason.trim(),
    person: await input.person(),
    blockers,
    ...(input.preflight === null ? {} : { preflight: input.preflight }),
  };
  (input.say ?? console.error)(overrideStatement(key, override));
  return { override };
}

/**
 * A preflight refusal as the claim returns it. One the command tagged as for
 * blockers alone stays overridable only where the gate applies and the
 * claim would not refuse anyway; elsewhere the override cannot clear it, so
 * it is not marked.
 */
export async function preflightRefusal(
  refusal: ClaimResult,
  input: Pick<GateInput, "applies" | "admission">,
): Promise<ClaimResult> {
  if (refusal.outcome !== "refused" || refusal.overridable !== true)
    return refusal;
  if (!input.applies) {
    const { overridable: _dropped, ...unmarked } = refusal;
    return unmarked;
  }
  return (await input.admission()) ?? refusal;
}

const reasonOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Whether an error proves the comment write never reached the tracker. */
function isDefinitelyUnsent(error: unknown): boolean {
  if (error instanceof TrackerRequestError) return true;
  if (error instanceof OutboundError && !error.sent)
    return (
      error.code === "rate-limited" ||
      error.code === "unauthorized" ||
      error.code === "not-found"
    );
  return false;
}

/** Whether a trusted comment on `key` already carries `attempt`. */
async function hasTrustedAttempt(
  tracker: Pick<Tracker, "issueComments">,
  key: string,
  attempt: string,
): Promise<boolean> {
  const { comments } = await tracker.issueComments(key);
  return comments.some(
    (c) => c.trusted && overrideAttemptsIn(c.body).includes(attempt),
  );
}

/**
 * Post an override comment idempotently for `attempt`: read trusted comments
 * first so an existing record is never duplicated, refuse to post blindly
 * when comments cannot be read (`indeterminate`), and reconcile against
 * trusted comments when a post fails ambiguously after sending.
 */
export async function ensureOverrideComment(
  tracker: Pick<Tracker, "issueComments" | "postComment">,
  key: string,
  body: string,
  attempt: string,
): Promise<OverrideCommentOutcome> {
  const marker = overrideMarkerLine(attempt);
  try {
    if (await hasTrustedAttempt(tracker, key, attempt))
      return { status: "posted", posted: true, attempt, alreadyPresent: true };
  } catch (error) {
    return {
      status: "indeterminate",
      posted: false,
      attempt,
      marker,
      reason: `could not inspect existing trusted comments before posting attempt ${attempt}: ${reasonOf(error)}`,
    };
  }
  const marked = overrideAttemptsIn(body).includes(attempt)
    ? body
    : `${body.trimEnd()}\n\n${marker}\n`;
  try {
    await tracker.postComment(key, marked);
    return { status: "posted", posted: true, attempt };
  } catch (error) {
    const writeReason = reasonOf(error);
    if (isDefinitelyUnsent(error))
      return {
        status: "not_posted",
        posted: false,
        attempt,
        marker,
        reason: writeReason,
      };
    try {
      if (await hasTrustedAttempt(tracker, key, attempt))
        return {
          status: "posted",
          posted: true,
          attempt,
          alreadyPresent: true,
        };
      return {
        status: "indeterminate",
        posted: false,
        attempt,
        marker,
        reason: `${writeReason} (the comment may have landed before its response was lost; attempt ${attempt} was not seen among trusted comments)`,
      };
    } catch (readError) {
      return {
        status: "indeterminate",
        posted: false,
        attempt,
        marker,
        reason: `${writeReason} (could not inspect trusted comments to verify attempt ${attempt}: ${reasonOf(readError)})`,
      };
    }
  }
}

/**
 * Post an issue comment, using the idempotent override check whenever the
 * body carries a `jig:blocker-override` marker. Ordinary comments pass
 * straight through to `postComment`.
 */
export async function postCommentChecked(
  tracker: Pick<Tracker, "issueComments" | "postComment">,
  key: string,
  body: string,
): Promise<
  | { issue: string; commented: true }
  | ({ issue: string; commented: boolean } & OverrideCommentOutcome)
> {
  const attempt = overrideAttemptInBody(body);
  if (attempt === null) {
    await tracker.postComment(key, body);
    return { issue: key, commented: true };
  }
  const outcome = await ensureOverrideComment(tracker, key, body, attempt);
  return { issue: key, commented: outcome.posted, ...outcome };
}

/**
 * Record a landed claim's override on the item: one idempotent comment, then
 * the repository's override label where it sets one. Neither undoes the claim
 * when it fails; the report says what was not recorded.
 */
export async function recordOverride(
  tracker: Pick<Tracker, "issueComments" | "postComment" | "updateIssue">,
  key: string,
  override: BlockerOverride,
  label: string | null,
): Promise<OverrideReport> {
  const attempt = override.attempt ?? randomUUID();
  const body = overrideComment(key, override, attempt);
  const comment = await ensureOverrideComment(tracker, key, body, attempt);
  const recorded = { ...override, attempt };
  if (label === null) return { ...recorded, comment };
  try {
    await tracker.updateIssue(key, { addLabels: [label] });
    return { ...recorded, comment, label: { name: label, added: true } };
  } catch (error) {
    return {
      ...recorded,
      comment,
      label: { name: label, added: false, reason: reasonOf(error) },
    };
  }
}

/** The claim's result with what it recorded of an override; unchanged without one. */
export async function withOverrideRecorded<R extends ClaimResult>(
  tracker: Pick<Tracker, "issueComments" | "postComment" | "updateIssue">,
  result: R,
  override: BlockerOverride | null,
  label: string | null,
  say: (line: string) => void = console.error,
): Promise<R | (R & { override: OverrideReport })> {
  if (override === null || result.outcome !== "claimed") return result;
  const report = await recordOverride(tracker, result.issue, override, label);
  if (!report.comment.posted)
    say(
      report.comment.status === "indeterminate"
        ? `the override comment for ${plain(result.issue)} (attempt ${report.attempt}) could not be confirmed: ${plain(report.comment.reason)}`
        : `the override of ${plain(result.issue)}'s blockers was not recorded in a comment (attempt ${report.attempt}): ${plain(report.comment.reason)}`,
    );
  if (report.label !== undefined && !report.label.added)
    say(
      `the label ${plain(report.label.name)} was not added to ${plain(result.issue)}: ${plain(report.label.reason)}`,
    );
  return { ...result, override: report };
}
