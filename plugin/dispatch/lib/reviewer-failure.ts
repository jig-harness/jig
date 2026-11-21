/** Re-arm a reviewer failure below the per-head threshold, and hold it after. */
import { isRecord } from "../../shared/guards.ts";
import { attempt, failed, ok, type Outcome } from "../../shared/outcome.ts";
import {
  DEFAULT_REVIEWED_SHA_MARKER,
  DEFAULT_STICKY_MARKER,
  defaultReviewerCheckFor,
} from "../../skills/drive-pr/scripts/lib/overlay.ts";
import { lastStopEvent } from "../../skills/drive-pr/scripts/lib/state/events.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { checkPattern } from "../../skills/drive-pr/scripts/lib/merge-ready.ts";
import { reviewerProfile } from "../../skills/drive-pr/scripts/lib/reviewer-profiles.ts";
import { checkRunsFor } from "../../skills/drive-pr/scripts/lib/status/commit-observations.ts";
import {
  judgeReviewObject,
  latestReviewBy,
} from "../../skills/drive-pr/scripts/lib/status/review-object.ts";
import { resolveMarkerSha } from "../../skills/drive-pr/scripts/lib/status/reviewed-sha.ts";
import { reviewerStickyIn } from "../../skills/drive-pr/scripts/lib/status/reviewer-sticky.ts";
import { parseMs } from "../../shared/time.ts";
import { DRIVE_EXIT } from "../../skills/drive-pr/scripts/lib/status/terminal-states.ts";
import { heldRead, unlessEnded, type TickBound } from "./sources/bounded.ts";
import type { Classified } from "./sources/ledgers.ts";
import type { Evidence } from "./types.ts";

export const DEFAULT_REVIEWER_FAILURES_BEFORE_ESCALATION = 3;

export type ReviewerFailurePolicy = {
  threshold: number;
  app?: string;
  currentReviewerConfigured: boolean;
  malformedReviewerSetting: boolean;
  sticky: string;
  stamp: string;
  skipNoticeMarker: string;
  bots: readonly string[];
  checkPattern?: string;
  evidence?: "sticky" | "review_object";
};

export function reviewerFailurePolicy(
  values: Record<string, unknown>,
  threshold = DEFAULT_REVIEWER_FAILURES_BEFORE_ESCALATION,
): ReviewerFailurePolicy {
  const review = isRecord(values.review) ? values.review : {};
  const bots = Array.isArray(review.bots) ? review.bots : [];
  const app =
    typeof review.reviewer_app === "string" && review.reviewer_app.trim() !== ""
      ? review.reviewer_app
      : undefined;
  const configuredCheckPattern =
    typeof review.reviewer_check_pattern === "string" &&
    review.reviewer_check_pattern.trim() !== ""
      ? review.reviewer_check_pattern
      : undefined;
  const malformedReviewerSetting = hasMalformedReviewerSetting(
    review,
    configuredCheckPattern,
  );
  const botLogins = bots.flatMap((bot: unknown) => {
    const login = isRecord(bot) ? bot.login : bot;
    return typeof login === "string" && login !== "" ? [login] : [];
  });
  return {
    threshold,
    ...(configuredCheckPattern === undefined
      ? {}
      : { checkPattern: configuredCheckPattern }),
    ...(app === undefined ? {} : { app }),
    currentReviewerConfigured:
      app !== undefined ||
      configuredCheckPattern !== undefined ||
      botLogins.length > 0 ||
      malformedReviewerSetting,
    malformedReviewerSetting,
    ...(review.reviewer_evidence === "sticky" ||
    review.reviewer_evidence === "review_object"
      ? { evidence: review.reviewer_evidence }
      : {}),
    sticky: stringOr(review.sticky_marker, DEFAULT_STICKY_MARKER),
    stamp: stringOr(review.reviewed_sha_marker, DEFAULT_REVIEWED_SHA_MARKER),
    skipNoticeMarker: stringOr(
      review.skip_notice_marker,
      "ai-review-skip-notice",
    ),
    bots: botLogins,
  };
}

function isBlankOrNonString(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    (typeof value !== "string" || value.trim() === "")
  );
}

function hasMalformedReviewerSetting(
  review: Record<string, unknown>,
  configuredCheckPattern: string | undefined,
): boolean {
  const unreadablePattern =
    configuredCheckPattern !== undefined &&
    !attempt("unreadable", "the reviewer check pattern could not be read", () =>
      checkPattern(configuredCheckPattern),
    ).ok;
  const badEvidence =
    review.reviewer_evidence !== undefined &&
    review.reviewer_evidence !== null &&
    review.reviewer_evidence !== "sticky" &&
    review.reviewer_evidence !== "review_object";
  return (
    [
      review.reviewer_app,
      review.reviewer_check_pattern,
      review.sticky_marker,
      review.reviewed_sha_marker,
      review.skip_notice_marker,
    ].some(isBlankOrNonString) ||
    unreadablePattern ||
    badEvidence
  );
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

type Stop = {
  head: string;
  app?: string;
  count: number;
};

/** Old exit-7 stops have no witnessed head and keep their original disposition. */
function witnessedStop(ledger: Ledger): Stop | null {
  if (
    ledger.driver.state !== "stopped" ||
    ledger.driver.exit !== DRIVE_EXIT.REVIEWER_FAILED ||
    ledger.driver.personStop !== undefined
  )
    return null;
  const cause = String(DRIVE_EXIT.REVIEWER_FAILED);
  const events = ledger.events ?? [];
  const last = lastStopEvent(events);
  if (last?.cause !== cause) return null;
  const started = parseMs(ledger.driver.started ?? "");
  // Recovery may append a second stop after the driver recorded its own.
  // Do not take evidence from an earlier acquisition of the same drive.
  const witness =
    last.reviewerHead === undefined
      ? events.findLast(
          (event) =>
            event.kind === "stop" &&
            event.cause === cause &&
            event.reviewerHead !== undefined &&
            parseMs(event.at) >= started,
        )
      : last;
  if (
    typeof witness?.reviewerHead !== "string" ||
    !/^[0-9a-f]{40}$/.test(witness.reviewerHead)
  )
    return null;
  const head = witness.reviewerHead;
  const app = witness.reviewerApp;
  if (
    app !== undefined &&
    (typeof app !== "string" || !/^[a-z0-9-]+$/i.test(app))
  )
    return null;
  const count = events.filter(
    (event) =>
      event.kind === "stop" &&
      event.cause === cause &&
      event.reviewerHead === head &&
      event.reviewerApp === app,
  ).length;
  return { head, count, ...(app === undefined ? {} : { app }) };
}

/** Observe the same witness the drive expects on this head. */
async function recovered(
  slug: string,
  pr: number,
  stop: Stop,
  comments: readonly unknown[],
  policy: ReviewerFailurePolicy,
  isDraft: boolean,
  cwd?: string,
  bound?: TickBound,
): Promise<Outcome<boolean, "unreadable">> {
  // A reviewer-failure stop is only relevant while the current policy still
  // expects reviewer evidence. Removing that policy intentionally releases
  // old holds rather than preserving the stopped reviewer's requirement.
  if (!policy.currentReviewerConfigured) return ok(true);
  // Invalid reviewer settings must remain held until corrected. Evidence from
  // a configured bot cannot prove that an invalid policy is safe to re-arm.
  if (policy.malformedReviewerSetting) return ok(false);
  const app = policy.app;
  const logins = app === undefined ? policy.bots : [`${app}[bot]`];
  const mode =
    policy.evidence ?? reviewerProfile(app ?? "")?.evidence ?? "sticky";
  return heldRead(bound, "the reviewer's new evidence was read", async () => {
    if (mode === "sticky") {
      const sticky = reviewerStickyIn(
        comments,
        (login) => logins.includes(login),
        policy.sticky,
        policy.stamp,
        policy.skipNoticeMarker,
      );
      const sha = await resolveMarkerSha(sticky.sha, cwd);
      if (sticky.sha !== "" && sha === "")
        return failed(
          "unreadable",
          "the reviewer's abbreviated commit stamp could not be verified",
        );
      return ok(sha === stop.head);
    }
    const [owner, repo] = slug.split("/");
    if (app === undefined || !owner || !repo) return ok(false);
    const pattern = attempt(
      "unreadable",
      "the reviewer check pattern could not be read",
      () => checkPattern(policy.checkPattern ?? defaultReviewerCheckFor(app)),
    );
    if (!pattern.ok) return pattern;
    const runs = await checkRunsFor(owner, repo, stop.head, "observed");
    if (runs === null)
      return failed(
        "unreadable",
        "the reviewer's check runs could not be read",
      );
    const run = runs
      .filter((check) => check.app === app && pattern.value.test(check.name))
      .sort((a, b) => a.id - b.id)
      .at(-1);
    if (run === undefined || run.status !== "completed") return ok(false);
    return unlessEnded(
      bound,
      "the reviewer's pull-request reviews were read",
      async () => {
        const latest = await latestReviewBy(
          owner,
          repo,
          String(pr),
          `${app}[bot]`,
        );
        if (latest === null)
          return failed(
            "unreadable",
            "the reviewer's reviews could not be read",
          );
        return ok(
          judgeReviewObject(run, latest.review, stop.head, isDraft, app)
            .state === "witnessed",
        );
      },
    );
  });
}

export async function reviewerFailureDisposition(
  slug: string,
  pr: number,
  ledger: Ledger,
  head: string | null,
  comments: readonly unknown[],
  policy: ReviewerFailurePolicy,
  isDraft: boolean,
  cwd?: string,
  bound?: TickBound,
): Promise<{ classified: Classified; evidence: Evidence } | null> {
  const stop = witnessedStop(ledger);
  if (stop === null) return null;
  const label = stop.app ?? "the configured reviewer";
  const rearm = (
    why: string,
  ): { classified: Classified; evidence: Evidence } => ({
    classified: { class: "re-armable", why },
    evidence: {},
  });
  if (!head)
    return {
      classified: {
        class: "unplaced",
        why: "the reviewer failed, and the pull request's current head could not be read",
      },
      evidence: {},
    };
  if (head !== stop.head)
    return rearm(`the pull request has a new head since ${label} failed`);
  if (stop.count < policy.threshold)
    return rearm(
      `${label} failed on ${head} (${stop.count} of ${policy.threshold} stops before escalation)`,
    );
  const recovery = await recovered(
    slug,
    pr,
    stop,
    comments,
    policy,
    isDraft,
    cwd,
    bound,
  );
  if (recovery.ok && recovery.value)
    return rearm(`${label} has now reviewed ${head}`);
  return {
    classified: {
      class: "needs-person",
      why: `${label} failed ${stop.count} times on ${head}; waiting for a review of that head or for the head to change`,
    },
    evidence: {
      reviewerFailureHead: head,
      reviewerFailureApp: label,
      ...(recovery.ok ? {} : { reviewerRecoveryRead: recovery.failure.reason }),
    },
  };
}
