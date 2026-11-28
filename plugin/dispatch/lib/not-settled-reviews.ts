/**
 * The reviews of the head a drive that keeps stopping `NOT_SETTLED` waits
 * on (`repeated-ends.ts`): read only for a drive whose re-arm is held back,
 * under its cap and inside its backoff, so a tick spends one forge read on
 * each such drive and none on any other. The latest time a review of the
 * pull request's current head was submitted goes into the drive's evidence
 * (`headReviewedAt`), which ends the backoff when it is later than the last
 * stop. A read that fails leaves the backoff standing, and the reason says
 * the reviews did not read (`headReviewsUnread`): an unreadable forge never
 * starts a re-arm early, and the backoff still ends on its own.
 */
import { isRecord } from "../../shared/guards.ts";
import { failed, ok, type Outcome } from "../../shared/outcome.ts";
import { parseMs } from "../../shared/time.ts";
import { ghJson } from "./forge.ts";
import type { ReadRecord } from "./launches.ts";
import type { NotSettledSettings } from "./not-settled-config.ts";
import { notSettledWaiting } from "./repeated-ends.ts";
import type { DrivenPr } from "./types.ts";

/** A pull request's latest reviews: each one's commit and when it was submitted. */
const REVIEWS_QUERY = `query DispatchHeadReviews($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviews(last: 20) { nodes { state submittedAt commit { oid } } }
    }
  }
}`;

/** One submitted review: the commit it reviewed and when. */
export interface SubmittedReview {
  commit: string;
  submittedAt: string;
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

/**
 * A pull request's latest submitted reviews, by anyone, oldest first; a
 * pending review, which only its author sees, is passed over. One call of
 * one page, given `timeoutSec` when the caller holds a deadline.
 */
export async function submittedReviews(
  slug: string,
  pr: number,
  timeoutSec?: number,
): Promise<Outcome<SubmittedReview[], "unreadable">> {
  const [owner, name] = slug.split("/");
  const answer = await ghJson(
    [
      "api",
      "graphql",
      "-f",
      `query=${REVIEWS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `pr=${pr}`,
    ],
    "the reviews answer",
    undefined,
    timeoutSec,
    slug,
  );
  if (!answer.ok) return answer;
  const nodes = field(
    field(
      field(field(field(answer.value, "data"), "repository"), "pullRequest"),
      "reviews",
    ),
    "nodes",
  );
  if (!Array.isArray(nodes))
    return failed("unreadable", `PR #${pr}'s reviews did not read`);
  return ok(
    nodes.flatMap((n) => {
      const commit = field(field(n, "commit"), "oid");
      const at = field(n, "submittedAt");
      return field(n, "state") !== "PENDING" &&
        typeof commit === "string" &&
        typeof at === "string"
        ? [{ commit, submittedAt: at }]
        : [];
    }),
  );
}

type ReviewReader = (
  slug: string,
  pr: number,
) => Promise<Outcome<SubmittedReview[], "unreadable">>;

/** The latest submission time among `reviews` of `head`; `null` for none. */
function latestOf(
  reviews: readonly SubmittedReview[],
  head: string,
): string | null {
  let latest: string | null = null;
  for (const r of reviews)
    if (
      r.commit === head &&
      Number.isFinite(parseMs(r.submittedAt)) &&
      (latest === null || parseMs(r.submittedAt) > parseMs(latest))
    )
      latest = r.submittedAt;
  return latest;
}

/** Forge reads in flight at once: a long waiting list never fans out into one request each. */
const READS_AT_ONCE = 4;

/** `each` over `items`, at most `READS_AT_ONCE` at a time, in order. */
async function inBatches<T, R>(
  items: readonly T[],
  each: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += READS_AT_ONCE)
    out.push(
      ...(await Promise.all(items.slice(i, i + READS_AT_ONCE).map(each))),
    );
  return out;
}

/** Each drive held back by its `NOT_SETTLED` backoff, with when its head was last reviewed, or why its reviews did not read. */
export async function withHeadReviews(
  slug: string,
  drives: readonly DrivenPr[],
  records: readonly ReadRecord[],
  settings: NotSettledSettings,
  nowMs: number,
  read: ReviewReader = submittedReviews,
): Promise<DrivenPr[]> {
  const own = records.filter((r) => r.record.repo === slug);
  return inBatches(drives, async (pr) => {
    const head = pr.evidence.headSha;
    if (
      typeof head !== "string" ||
      !notSettledWaiting(pr, own, settings, nowMs)
    )
      return pr;
    const reviews = await read(slug, pr.number);
    if (!reviews.ok)
      return {
        ...pr,
        evidence: {
          ...pr.evidence,
          headReviewsUnread: reviews.failure.reason,
        },
      };
    const at = latestOf(reviews.value, head);
    return at === null
      ? pr
      : { ...pr, evidence: { ...pr.evidence, headReviewedAt: at } };
  });
}
