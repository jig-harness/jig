#!/usr/bin/env bun
/**
 * Resolve a review thread by its GraphQL node id. Pins the resolveReviewThread
 * mutation shape. Prints the resulting isResolved (should be `true`).
 * Resolution lives only in GraphQL — REST can neither read nor set it.
 *
 * Usage: bun resolve-thread.ts <THREAD_NODE_ID>
 *   THREAD_NODE_ID = the `threadId` field from list-unresolved-threads.ts
 *
 * Precondition (skill invariant): only call AFTER a fix or a reply is posted —
 * never resolve a thread with no audit trail.
 */

import { runMain } from "./lib/cli.ts";
import { ghOrExit } from "./lib/gh.ts";
import { assertThreadPrOpen } from "./lib/thread-liveness.ts";

// Gated behind `import.meta.main` rather than run at module scope: this module's
// side effect is a MUTATION, so importing it — the pattern the rest of this
// family supports for its pure helpers — would resolve a thread for real.
// See the sibling note in unresolve-thread.ts.
async function main(): Promise<number> {
  const threadId = process.argv[2] ?? "";
  if (threadId === "") {
    console.error("usage: resolve-thread.ts <thread-node-id>");
    return 2;
  }

  await assertThreadPrOpen("resolve-thread", threadId);
  process.stdout.write(
    await ghOrExit("resolve-thread", [
      "api",
      "graphql",
      "-f",
      `query=
mutation($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){ thread{ isResolved } }
}`,
      "-f",
      `threadId=${threadId}`,
      "-q",
      ".data.resolveReviewThread.thread.isResolved",
    ]),
  );
  return 0;
}

if (import.meta.main) runMain("resolve-thread", main);
