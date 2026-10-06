#!/usr/bin/env bun
/**
 * Unresolve a review thread by its GraphQL node id. Pins the
 * unresolveReviewThread mutation shape. Prints the resulting isResolved
 * (should be `false`). Resolution lives only in GraphQL — REST can neither
 * read nor set it.
 *
 * Usage: bun unresolve-thread.ts <THREAD_NODE_ID>
 *   THREAD_NODE_ID = the `threadId` field from list-unresolved-threads.ts
 *
 * For the mistake case only (skill § "Resolving — but not for accepted yet"):
 * a thread resolved before its reply posted or before its fix's push landed
 * must be reopened so the audit trail completes in order. Do not use it to
 * re-litigate a settled outcome — post a new reply with the new outcome token
 * instead; the reply sequence is the audit trail.
 */

import { isEntryPoint, runMain } from "./lib/cli.ts";
import { ghOrExit } from "./lib/gh.ts";

// Gated behind isEntryPoint like every other script in this family, rather
// than running at import time. This module's side effect is a MUTATION, and
// the node sweep in the test suite spawns each script here with `--help`,
// which this one reads as a thread id — that spawn is safe only because the
// sweep stubs `gh`, an accident of the harness rather than a property of the
// script. Importing it (the pure-helper pattern the rest of the family
// supports) would fire the mutation for real (coderabbitai, PR #4040).
async function main(): Promise<number> {
  const threadId = process.argv[2] ?? "";
  if (threadId === "") {
    console.error("usage: unresolve-thread.ts <thread-node-id>");
    return 2;
  }

  process.stdout.write(
    await ghOrExit("unresolve-thread", [
      "api",
      "graphql",
      "-f",
      `query=
mutation($threadId:ID!){
  unresolveReviewThread(input:{threadId:$threadId}){ thread{ isResolved } }
}`,
      "-f",
      `threadId=${threadId}`,
      "-q",
      ".data.unresolveReviewThread.thread.isResolved",
    ]),
  );
  return 0;
}

if (isEntryPoint(import.meta.url)) runMain("unresolve-thread", main);
