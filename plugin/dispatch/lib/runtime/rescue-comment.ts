/**
 * A pull request whose branch an open freed by keeping a holder's unpushed
 * commits on a rescue branch (`shared/orca-workspace/holder.ts`) gets a
 * comment naming that branch and the clone it is in, so whoever owned the
 * holder finds the commits from the pull request, not only from the tick's
 * receipt. The comment is one forge call per rescue, which is rare; a
 * comment the forge refuses leaves the open as it was, the refusal in the
 * receipt's detail. An open with no rescue, or for an item or the notices,
 * posts nothing.
 */
import { shellQuote } from "../../../shared/cli.ts";
import type { Outcome } from "../../../shared/outcome.ts";
import { commentOnPull } from "../forge.ts";
import type { DetachedCheckout } from "../types.ts";
import type { SessionRuntime } from "./port.ts";

/** The comment: where the checkout was, the commit it was left at, and where its commits are kept. */
export function rescueCommentBody(
  detached: DetachedCheckout & { rescue: { branch: string; clone: string } },
): string {
  return [
    `The dispatcher freed \`${detached.branch}\` for this pull request's workspace: the checkout at \`${detached.path}\` held it with commits the remote lacked.`,
    "",
    `Those commits are kept on the local branch \`${detached.rescue.branch}\` in the clone at \`${detached.rescue.clone}\`. Nothing pushes or collects that branch; the checkout was left detached at \`${detached.head.slice(0, 12)}\` with its files as they were, and where the remote has the branch, the local branch was moved back to the remote's copy.`,
    "",
    `To carry the work on, push the rescue branch or cherry-pick its commits; delete it with \`git -C ${shellQuote(detached.rescue.clone)} branch -D ${detached.rescue.branch}\` once nothing on it is needed.`,
  ].join("\n");
}

type Poster = (
  slug: string,
  pr: number,
  body: string,
) => Promise<Outcome<void, "refused">>;

/** `runtime`, its opens of a pull request's workspace commenting on the pull request when they rescued a holder's commits. */
export function withRescueComments(
  runtime: SessionRuntime,
  post: Poster = commentOnPull,
): SessionRuntime {
  return {
    ...runtime,
    async openWorkspace(repo, target) {
      const receipt = await runtime.openWorkspace(repo, target);
      const detached = receipt.detached;
      const rescue = detached?.rescue;
      if (detached === undefined || rescue === undefined || !("pr" in target))
        return receipt;
      const posted = await post(
        repo.slug,
        target.pr,
        rescueCommentBody({ ...detached, rescue }),
      );
      return {
        ...receipt,
        detail: posted.ok
          ? `${receipt.detail}; PR #${target.pr} has a comment naming the rescue branch ${rescue.branch}`
          : `${receipt.detail}; the comment naming the rescue branch ${rescue.branch} was not posted on PR #${target.pr}: ${posted.failure.reason}`,
      };
    },
  };
}
