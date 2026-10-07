/**
 * Read the owning PR directly from the thread node immediately before a write.
 * Never reuse enumeration or cached round state: a PR may merge during a pass.
 * GitHub does not offer an open-state precondition on these mutations, so a
 * merge between this read and the write remains possible; this is not atomic.
 */
import { fail } from "./cli.ts";
import { ghOrExit } from "./gh.ts";

interface LivenessResponse {
  errors?: unknown;
  data?: {
    node?: {
      __typename?: unknown;
      id?: unknown;
      pullRequest?: { number?: unknown; state?: unknown };
    };
  };
}

export async function assertThreadPrOpen(
  label: string,
  threadId: string,
): Promise<void> {
  let response: LivenessResponse | null = null;
  try {
    // One uncached request resolves ownership and reads state. No current-branch
    // lookup or DRIVE_PR_TARGET: either could name a different PR.
    response = JSON.parse(
      await ghOrExit(label, [
        "api",
        "graphql",
        "-f",
        "query=query($threadId:ID!){ node(id:$threadId){ __typename ... on PullRequestReviewThread { id pullRequest { number state } } } }",
        "-f",
        `threadId=${threadId}`,
      ]),
    );
  } catch {
    fail(
      1,
      `${label}: cannot read owning PR liveness for thread ${threadId}; refusing mutation — stop the review pass.`,
    );
  }

  const node = response?.data?.node;
  const pr = node?.pullRequest;
  if (
    response?.errors !== undefined ||
    node?.__typename !== "PullRequestReviewThread" ||
    node?.id !== threadId ||
    typeof pr?.number !== "number" ||
    !Number.isSafeInteger(pr?.number) ||
    pr.number <= 0 ||
    typeof pr.state !== "string" ||
    !["OPEN", "CLOSED", "MERGED"].includes(pr.state)
  ) {
    fail(
      1,
      `${label}: cannot read owning PR liveness for thread ${threadId} (invalid GitHub response); refusing mutation — stop the review pass.`,
    );
  }
  if (pr.state !== "OPEN") {
    fail(
      5,
      `${label}: owning PR #${pr.number} is ${pr.state}; refusing mutation — stop the review pass.`,
    );
  }
}
