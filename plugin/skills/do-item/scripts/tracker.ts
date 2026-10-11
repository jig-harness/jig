#!/usr/bin/env bun
/**
 * Tracker operations from the command line, through the consumer's tracker
 * (`issue_tracker` in `.config/groundwork-overlay.yaml`).
 *
 * Usage:
 *     bun tracker.ts children <issue-key>
 *     bun tracker.ts transition <issue-key> <canonical-state>
 *     bun tracker.ts comment <issue-key>          # body on stdin
 *     bun tracker.ts states                       # canonical → tracker names
 *     bun tracker.ts labels                       # label role → tracker labels
 *
 * Canonical states: backlog, todo, in_progress, in_review, done, canceled,
 * and where the consumer uses them triage, ops_pending, duplicate.
 *
 * Output: JSON on stdout. Exit codes: 0 done, 2 usage, 1 the operation
 * failed (the reason on stderr).
 *
 * Runs under Bun and under Node ≥ 22.18 (type stripping).
 */

import { isEntryPoint } from "./lib/cli.ts";
import { ownTrackerConfig } from "./lib/tracker/config.ts";
import {
  CANONICAL_STATES,
  type CanonicalState,
  openTracker,
} from "./lib/tracker/index.ts";
import { labelsAsConfig } from "../../resolve-review-comments/scripts/lib/tracker-labels.ts";

const USAGE = `usage:
  tracker.ts children <issue-key>
  tracker.ts transition <issue-key> <canonical-state>
  tracker.ts comment <issue-key>   (body on stdin)
  tracker.ts states
  tracker.ts labels`;

async function readStdin(): Promise<string> {
  process.stdin.setEncoding("utf8");
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  return s;
}

function usage(message: string): number {
  console.error(`${message}\n${USAGE}`);
  return 2;
}

export async function main(argv: string[]): Promise<number> {
  const [op, key, state, ...rest] = argv;
  if (rest.length > 0) return usage("too many arguments");
  try {
    switch (op) {
      case "states": {
        if (key !== undefined) return usage("states takes no argument");
        console.log(JSON.stringify(ownTrackerConfig().states, null, 2));
        return 0;
      }
      case "labels": {
        if (key !== undefined) return usage("labels takes no argument");
        console.log(
          JSON.stringify(labelsAsConfig(ownTrackerConfig().labels), null, 2),
        );
        return 0;
      }
      case "children": {
        if (key === undefined || state !== undefined)
          return usage("children takes one issue key");
        console.log(
          JSON.stringify(await openTracker().listChildren(key), null, 2),
        );
        return 0;
      }
      case "transition": {
        if (key === undefined || state === undefined)
          return usage("transition takes an issue key and a canonical state");
        if (!(CANONICAL_STATES as readonly string[]).includes(state))
          return usage(
            `'${state}' is not a canonical state (${CANONICAL_STATES.join(", ")})`,
          );
        const tracker = openTracker();
        await tracker.transition(key, state as CanonicalState);
        console.log(
          JSON.stringify({
            issue: key,
            state,
            name: tracker.stateName(state as CanonicalState),
          }),
        );
        return 0;
      }
      case "comment": {
        if (key === undefined || state !== undefined)
          return usage("comment takes one issue key; the body comes on stdin");
        const body = await readStdin();
        if (body.trim() === "") return usage("the comment body is empty");
        await openTracker().postComment(key, body);
        console.log(JSON.stringify({ issue: key, commented: true }));
        return 0;
      }
      default:
        return usage(
          op === undefined ? "missing operation" : `unknown operation: ${op}`,
        );
    }
  } catch (err) {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (isEntryPoint(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
