/**
 * The shared records on the forge (`shared.ts`'s first implementation): each
 * claim is a comment on the pull request its launch concerns, a claim of the
 * forge-claims module (`forge-claims.ts`) of the kind its stage publishes
 * (`launch-claims.ts`): the launch claim for a drive, the follow-up marker
 * for a follow-up. A launch's end is written by editing its claim's own
 * comment, so a record and its end are one comment, and every read goes
 * through the module's trusted listing: a comment counts only when the
 * caller's own forge login wrote it or the forge vouches for its author as an
 * owner, member or collaborator.
 *
 * A drive's claim first reads the pull request's launch claims: a current
 * claim with no end holds the launch (`held`), and nothing is posted; a
 * trusted claim that does not read leaves the launch unclaimed until a person
 * settles it. Otherwise it posts a claim on the attempt after the latest and
 * reads it back. The forge offers no conditional create for a comment and its
 * listing can lag, so the read-back reads again a bounded number of times
 * while the listing does not show the caller's own comment, and then reports
 * it `missing` rather than counting a comment it never saw; of the claims on
 * one attempt the earliest trusted comment wins. What this cannot close is
 * `forge-claims.ts`'s residue: two read-backs that each lag past the other's
 * comment both read themselves the winner. The stage's own refusal is the
 * backstop there (the drive's lock and ledger claim, a follow-up's re-check
 * before each act), and the next read that lists both shows the earlier as
 * the winner.
 *
 * These records coordinate launches between hosts; nothing reads one as
 * leave for an act a person takes.
 *
 * Every forge call goes through `ghCall` (`../proc.ts`), under its deadline;
 * every method returns an `Outcome`, and each read and write is reported to
 * the caller's `record` for its receipt.
 */
import { isRecord } from "../guards.ts";
import { failed, ok, type Outcome } from "../outcome.ts";
import { ghCall } from "../proc.ts";
import {
  amend,
  type ClaimTarget,
  check as checkClaim,
  type ListedClaim,
  list as listClaims,
  post as postClaim,
  type Standing,
  withdraw,
} from "./forge-claims.ts";
import {
  DRIVE_KEY,
  draftClaim,
  endedClaim,
  FOLLOWUP_KEY,
  kindOf,
  launchClaim,
  saysOf,
} from "./launch-claims.ts";
import {
  type CheckAnswer,
  type ClaimAnswer,
  type ClaimCode,
  current,
  type LaunchDraft,
  type LaunchEnd,
  nextAttempt,
  open,
  type ReadBackRule,
  type ReadClaim,
  type SharedBudget,
  type SharedClaim,
  type SharedOp,
  type SharedRecords,
  type SharedStage,
  type SharedTarget,
  unreadable,
} from "./shared.ts";
import { localWriter } from "./writer.ts";

export interface ForgeSharedOptions {
  /** The caller's own forge login, whose claims it trusts; `null` when unknown. */
  login: string | null;
  /** Told of each read and write, for the caller's receipt. */
  record?: (op: SharedOp) => void;
}

const targetOf = (t: SharedTarget): ClaimTarget => ({
  repo: t.repo,
  number: t.pr,
});
const named = (t: SharedTarget) => `PR #${t.pr}`;

/** A listed comment as a shared claim of `stage`. */
function sharedOf(stage: SharedStage, c: ListedClaim, pr: number): SharedClaim {
  return {
    id: c.id,
    stage,
    login: c.login,
    createdAt: c.createdAt,
    trusted: c.trusted,
    says: c.record.ok ? ok(saysOf(stage, c.record.value, pr)) : c.record,
  };
}

/** Whether a claim that reads is the draft's own launch: the same host and launch record. */
function sameLaunch(c: ReadClaim, draft: LaunchDraft): boolean {
  const says = c.says.value;
  return (
    draft.record !== null &&
    says.record === draft.record &&
    says.host === draft.host
  );
}

/** Why a pull request's launch claims leave its launch unclaimed: a trusted one does not read, for a person to settle; `null` when none. */
function damaged(claims: readonly SharedClaim[]): string | null {
  const [bad] = unreadable(claims);
  if (bad === undefined) return null;
  const why = bad.says.ok ? "" : `: ${bad.says.failure.reason}`;
  return `a trusted launch claim (comment ${bad.id} by ${bad.login}) does not read${why}; a person settles it`;
}

/**
 * The answer a current claim with no end gives a new launch before anything
 * is posted: the caller's own claim for the same launch already holds it, or
 * another holds it, which only a first-time takeover claims past, since the
 * driver it replaces is wedged (a replay of a takeover already made does not:
 * a later claim of another's superseded it); `null` when nothing holds the
 * launch.
 */
function holder(
  claims: readonly SharedClaim[],
  draft: LaunchDraft,
): ClaimAnswer | null {
  const held = current(claims);
  if (held === null || !open(held)) return null;
  if (sameLaunch(held, draft))
    return { kind: "holds", id: held.id, attempt: held.says.value.attempt };
  return draft.action === "takeover" && draft.replay !== true
    ? null
    : { kind: "held", by: held };
}

/** Whether the caller's own claim reads as the draft posted it. */
function readsAsPosted(own: SharedClaim, draft: LaunchDraft): boolean {
  if (!own.trusted || !own.says.ok) return false;
  const says = own.says.value;
  if (says.run !== draft.run) return false;
  if (draft.run === "manual") return says.end === null;
  return says.record === draft.record && says.end === null;
}

/**
 * A read-back's standing as the claim's answer: an earlier trusted claim
 * wins whatever its record says; a claim the read never listed is
 * `missing`; one whose body no longer says what its poster wrote is
 * `altered`, except a person's follow-up claim marked done meanwhile, whose
 * completion stands.
 */
export function answerOf(
  stage: SharedStage,
  pr: number,
  id: number,
  seen: Outcome<Standing, "unreadable">,
  draft: LaunchDraft,
  attempt: number,
): ClaimAnswer {
  if (!seen.ok) return { kind: "unreadable", id, reason: seen.failure.reason };
  const { verdict, winner, own, listing } = seen.value;
  const earlier = listing.find((c) => c.id === winner?.id);
  if (verdict === "lost-to" && earlier !== undefined)
    return { kind: "earlier", id, by: sharedOf(stage, earlier, pr) };
  if (own === null || !own.trusted)
    return {
      kind: "missing",
      id,
      reason:
        seen.value.reason ||
        `the read-back does not list the posted claim (comment ${id})`,
    };
  const mine = sharedOf(stage, own, pr);
  if (verdict === "holds" && readsAsPosted(mine, draft))
    return { kind: "holds", id, attempt };
  // A person finished the manual run between the post and the read-back: the completion stands.
  if (
    draft.run === "manual" &&
    mine.says.ok &&
    mine.says.value.run === "manual" &&
    mine.says.value.end !== null
  )
    return { kind: "done", id };
  return {
    kind: "altered",
    id,
    reason: `the posted claim (comment ${id}) no longer reads as posted`,
  };
}

/** A re-check's standing as the interface answers it. */
function checkAnswer(
  stage: SharedStage,
  pr: number,
  seen: Standing,
): CheckAnswer {
  const won = seen.listing.find((c) => c.id === seen.winner?.id);
  return {
    verdict: seen.verdict,
    own: seen.own === null ? null : sharedOf(stage, seen.own, pr),
    winner: won === undefined ? null : sharedOf(stage, won, pr),
    reason: seen.reason,
  };
}

/**
 * A drive claim holds the launch only while it is the pull request's current
 * claim and has no end: the re-check weighs the claim on its own attempt, so
 * an earlier attempt's claim still reads as holding after a takeover won a
 * later one, and an ended claim still wins its attempt. Anything else is
 * `lost-to` the current claim, or `lost` when none is open.
 */
function stillCurrent(
  answer: CheckAnswer,
  own: number,
  claims: readonly SharedClaim[],
): CheckAnswer {
  if (answer.verdict !== "holds" || claims.length === 0) return answer;
  const now = current(claims);
  if (now !== null && now.id === own && open(now)) return answer;
  if (now !== null && now.id !== own && open(now))
    return {
      ...answer,
      verdict: "lost-to",
      winner: now,
      reason: `a later launch claim (comment ${now.id}, attempt ${now.says.value.attempt}) holds the launch`,
    };
  return {
    ...answer,
    verdict: "lost",
    winner: null,
    reason: `the claim (comment ${own}) no longer holds the launch: it has an end or no open claim is current`,
  };
}

/** What is left of the forge's core budget, as `gh api rate_limit` reports it, or why it does not read. */
async function readBudget(): Promise<Outcome<SharedBudget, "unreadable">> {
  const r = await ghCall(["api", "rate_limit"], { stderr: "pipe" });
  return r.code === 0
    ? budgetOf(r.stdout)
    : failed("unreadable", `the rate limit does not read: gh exited ${r.code}`);
}

/** The core budget `gh api rate_limit` reports, or why it does not read. */
function budgetOf(stdout: string): Outcome<SharedBudget, "unreadable"> {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return failed("unreadable", "the rate limit is not JSON");
  }
  const core =
    isRecord(value) && isRecord(value.resources)
      ? value.resources.core
      : undefined;
  if (
    !isRecord(core) ||
    typeof core.remaining !== "number" ||
    typeof core.limit !== "number" ||
    typeof core.reset !== "number"
  )
    return failed("unreadable", "the rate limit names no core budget");
  return ok({
    remaining: core.remaining,
    limit: core.limit,
    resetAt: new Date(core.reset * 1000).toISOString(),
  });
}

/** The shared records on the forge, read and written as `opts.login`. */
export function forgeShared(opts: ForgeSharedOptions): SharedRecords {
  const self = opts.login;
  const note = (op: SharedOp["op"], target: string, done: boolean) =>
    opts.record?.({ op, target, ok: done });

  async function list(
    target: SharedTarget,
    stage: SharedStage,
  ): Promise<Outcome<SharedClaim[], "unreadable">> {
    const listing = await listClaims(targetOf(target), kindOf(stage), self);
    note("list", named(target), listing.ok);
    return listing.ok
      ? ok(listing.value.map((c) => sharedOf(stage, c, target.pr)))
      : listing;
  }

  /** A drive's claim: read first, then post on the next attempt unless a current claim with no end holds the launch. */
  async function claimDrive(
    target: SharedTarget,
    draft: LaunchDraft,
    rule: ReadBackRule,
  ): Promise<Outcome<ClaimAnswer, ClaimCode>> {
    const listing = await list(target, "drive");
    if (!listing.ok) return listing;
    const bad = damaged(listing.value);
    if (bad !== null) return failed("unreadable", bad);
    const held = holder(listing.value, draft);
    if (held !== null) return republished(target, listing.value, draft, held);
    return post(target, draft, nextAttempt(listing.value), rule);
  }

  /**
   * The answer a held launch gives, once its own open claim names the changes
   * the draft acts on now: a replay that moved to a newer change publishes it
   * and the ones it moved on from before it launches, which other hosts
   * deduplicate against. A claim that cannot be rewritten holds nothing.
   */
  async function republished(
    target: SharedTarget,
    claims: readonly SharedClaim[],
    draft: LaunchDraft,
    held: ClaimAnswer,
  ): Promise<Outcome<ClaimAnswer, ClaimCode>> {
    if (held.kind !== "holds") return ok(held);
    const own = claims.find((c) => c.id === held.id);
    if (own === undefined || !own.says.ok) return ok(held);
    const wanted = [draft.change ?? null, ...(draft.earlier ?? [])];
    const says = own.says.value;
    const have = [says.change, ...(says.earlier ?? [])];
    if (wanted.join("\n") === have.join("\n")) return ok(held);
    const r = await amend(
      targetOf(target),
      kindOf("drive"),
      held.id,
      launchClaim(draft, held.attempt, says.at === "" ? undefined : says.at),
    );
    note("claim", named(target), r.ok);
    return r.ok
      ? ok(held)
      : failed(
          "not-posted",
          `the claim (comment ${held.id}) could not be rewritten with the change it acts on: ${r.failure.reason}`,
        );
  }

  async function post(
    target: SharedTarget,
    draft: LaunchDraft,
    attempt: number,
    rule: ReadBackRule,
  ): Promise<Outcome<ClaimAnswer, ClaimCode>> {
    const posted = await postClaim(
      targetOf(target),
      kindOf(draft.stage),
      draftClaim(draft, attempt),
      { self, rule },
    );
    note("claim", named(target), posted.ok);
    if (!posted.ok)
      return posted.failure.code === "no-comment-id"
        ? failed("no-claim-id", posted.failure.reason)
        : failed("not-posted", posted.failure.reason);
    const { id, standing } = posted.value;
    note("list", named(target), standing.ok);
    return ok(answerOf(draft.stage, target.pr, id, standing, draft, attempt));
  }

  async function check(
    target: SharedTarget,
    stage: SharedStage,
    own: number,
  ): Promise<Outcome<CheckAnswer, "unreadable">> {
    const attempt = await ownAttempt(target, stage, own);
    if (!attempt.ok) return attempt;
    const seen = await checkClaim(
      targetOf(target),
      kindOf(stage),
      stage === "drive" ? DRIVE_KEY : FOLLOWUP_KEY,
      own,
      { self, ...(attempt.value.attempt ?? {}) },
    );
    note("check", named(target), seen.ok);
    if (!seen.ok) return seen;
    const answer = checkAnswer(stage, target.pr, seen.value);
    return ok(
      stage === "drive"
        ? stillCurrent(
            answer,
            own,
            seen.value.listing.map((c) => sharedOf(stage, c, target.pr)),
          )
        : answer,
    );
  }

  /** The attempt the caller's own drive claim names, which its re-check weighs it on; none for a follow-up, which has one claim. */
  async function ownAttempt(
    target: SharedTarget,
    stage: SharedStage,
    own: number,
  ): Promise<Outcome<{ attempt?: { generation?: number } }, "unreadable">> {
    if (stage !== "drive") return ok({});
    const listing = await list(target, "drive");
    if (!listing.ok) return listing;
    const mine = listing.value.find((c) => c.id === own);
    return ok({
      attempt: mine?.says.ok ? { generation: mine.says.value.attempt } : {},
    });
  }

  async function end(
    target: SharedTarget,
    stage: SharedStage,
    own: number,
    ended: LaunchEnd,
    host?: string,
  ): Promise<Outcome<void, "unreadable" | "not-own" | "not-written">> {
    const listing = await listClaims(targetOf(target), kindOf(stage), self);
    note("list", named(target), listing.ok);
    if (!listing.ok) return listing;
    const mine = listing.value.find((c) => c.id === own);
    if (mine === undefined || !mine.trusted || !mine.record.ok)
      return failed(
        "not-own",
        `comment ${own} is not a trusted ${kindOf(stage).name} claim that reads on ${named(target)}`,
      );
    const r = await amend(
      targetOf(target),
      kindOf(stage),
      own,
      endedClaim(
        stage,
        mine.record.value,
        target.pr,
        ended,
        localWriter("forge", self),
        host,
      ),
    );
    note("end", named(target), r.ok);
    return r.ok ? ok(undefined) : failed("not-written", r.failure.reason);
  }

  return {
    medium: "forge",
    list,
    async listRepository(repo, prs, stage) {
      const out = new Map<number, Outcome<SharedClaim[], "unreadable">>();
      for (const pr of prs) out.set(pr, await list({ repo, pr }, stage));
      return out;
    },
    async claim(target, draft, rule = {}) {
      if (draft.stage === "drive") return claimDrive(target, draft, rule);
      return post(target, draft, 1, rule);
    },
    check,
    end,
    async release(target, own) {
      const r = await withdraw({ repo: target.repo }, own);
      note("release", named(target), r.ok);
      return r.ok ? ok(undefined) : failed("not-released", r.failure.reason);
    },
    async budget() {
      const read = await readBudget();
      note("budget", "the forge", read.ok);
      return read;
    },
  };
}
