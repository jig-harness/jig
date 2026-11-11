/**
 * Where an item stops after its pull request merges, read from `do_item` in
 * `.config/jig.yaml`:
 *
 *   do_item:
 *     post_merge_state: in_review   # done (default) | ops_pending | in_review
 *     post_merge_closer: "the release lead"
 *
 * `done` is the default: the post-merge rule moves a merged item to `done`
 * (or `ops_pending` while a manual step remains). A team whose `done` means
 * merged and verified by someone else stops the agent at `ops_pending` or
 * `in_review`, and `post_merge_closer` names who closes the item, for the
 * closing comment.
 *
 * A stop short of `done` needs `pull_requests.issue_link: refs`: the default
 * `closes` makes the forge, or a tracker's forge integration, close the item
 * on merge whatever the skills do, and `none` leaves the item unlinked.
 */

import { isRecord } from "../../../../shared/guards.ts";
import { JigError } from "../../../../shared/outcome.ts";
import {
  ISSUE_LINKS,
  type IssueLink,
} from "../../../drive-pr/scripts/lib/pr-policy.ts";
import { doItemSection } from "./overlay.ts";

export const POST_MERGE_STATES = ["done", "ops_pending", "in_review"] as const;

export type PostMergeState = (typeof POST_MERGE_STATES)[number];

export interface PostMergePolicy {
  /** The last state the post-merge rule moves an item to. */
  state: PostMergeState;
  /** Who closes an item the rule leaves short of `done`; `null` when unset. */
  closer: string | null;
}

export const DEFAULT_POST_MERGE: PostMergePolicy = {
  state: "done",
  closer: null,
};

/** A post-merge policy the configuration cannot hold; the message names the field. */
export class PostMergeConfigError extends JigError<"invalid-post-merge"> {
  override name = "PostMergeConfigError";
  constructor(reason: string) {
    super("invalid-post-merge", reason);
  }
}

/** The issue link `pull_requests.issue_link` sets, its default `closes`. */
function issueLinkOf(overlay: Record<string, unknown>): IssueLink {
  const section = overlay.pull_requests;
  const link = isRecord(section) ? (section.issue_link ?? "closes") : "closes";
  if (!(ISSUE_LINKS as readonly unknown[]).includes(link))
    throw new PostMergeConfigError(
      `pull_requests.issue_link must be one of ${ISSUE_LINKS.join(", ")} (got ${JSON.stringify(link)})`,
    );
  return link as IssueLink;
}

/**
 * `do_item.post_merge_state` and `do_item.post_merge_closer` from a parsed
 * overlay. Throws, naming the field, on a value outside the list, and on a
 * state short of `done` without `pull_requests.issue_link: refs`.
 */
export function parsePostMerge(
  overlay: Record<string, unknown> | null,
): PostMergePolicy {
  const section = doItemSection(overlay);
  if (!isRecord(section)) return DEFAULT_POST_MERGE;
  const rawState = section.post_merge_state ?? "done";
  if (!(POST_MERGE_STATES as readonly unknown[]).includes(rawState))
    throw new PostMergeConfigError(
      `do_item.post_merge_state must be one of ${POST_MERGE_STATES.join(", ")} (got ${JSON.stringify(rawState)})`,
    );
  const state = rawState as PostMergeState;
  const rawCloser = section.post_merge_closer ?? null;
  if (
    rawCloser !== null &&
    (typeof rawCloser !== "string" || rawCloser.trim() === "")
  )
    throw new PostMergeConfigError(
      "do_item.post_merge_closer must be a nonempty string",
    );
  if (state !== "done") {
    const link = issueLinkOf(overlay ?? {});
    if (link !== "refs")
      throw new PostMergeConfigError(
        `do_item.post_merge_state: ${state} needs pull_requests.issue_link: refs; with ${link}, ${
          link === "closes"
            ? "the forge closes the item when the pull request merges"
            : "the pull request does not name its item"
        }`,
      );
  }
  return { state, closer: rawCloser };
}

/**
 * The state a merged item moves to under the policy: `ops_pending` while a
 * manual step remains, whatever the policy; otherwise the policy's state.
 */
export function postMergeTarget(
  policy: PostMergePolicy,
  manualStepRemains: boolean,
): PostMergeState {
  return manualStepRemains ? "ops_pending" : policy.state;
}

/** The closing comment's sentence for an item the rule leaves short of `done`. */
export function closerSentence(policy: PostMergePolicy): string | null {
  if (policy.state === "done") return null;
  return policy.closer === null
    ? "A person closes this item once its completion is verified."
    : `${policy.closer} closes this item once its completion is verified.`;
}
