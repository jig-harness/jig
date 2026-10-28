#!/usr/bin/env bun
/**
 * Prepare a working tree to drive a pull request: `lib/attach.ts` says what
 * the attach does and refuses, `lib/attach-place.ts` where `--place` drives
 * it from.
 *
 * Usage:
 *   attach-pr.ts <PR>                 attach PR <PR> to this working tree
 *   attach-pr.ts <REF> --place        choose the tree that drives <REF> — this
 *                                     one, or from the clone's primary
 *                                     checkout the tree holding the PR, or a
 *                                     new one under gc.worktree_roots — and
 *                                     attach it there. <REF> is a number,
 *                                     owner/name#N, or a pull request URL; a
 *                                     PR in another repository is placed in
 *                                     the clone the user file's `clones` map
 *                                     names.
 *
 * Prints one JSON line on success: `{pr, branch, remote, head, worktree,
 * detached, created}` for an attach, `{pr, repo, tree, created}` for
 * `--place`. `drive.ts` attaches before it takes its locks, so arming a drive
 * runs this either way; `--place` is the arm step's, which needs to know the
 * tree before it can start the driver there.
 *
 * Exit codes:
 *   0  attached (or placed and attached)
 *   1  something could not be read: git, `gh`, the fetch
 *   2  refused, with the state named: uncommitted changes or an unfinished
 *      operation here or in the tree holding the branch, commits the PR's
 *      head lacks, the clone's primary checkout, a PR from a fork; or a
 *      usage error
 *   3  --place: the PR is in another repository with no clone mapped; the
 *      command to run there is printed
 *   5  the PR is not open
 */
import { fail, runMain } from "./lib/cli.ts";
import { AttachRefusal, attachPr } from "./lib/attach.ts";
import {
  attachIn,
  type PrRef,
  parsePrRef,
  placePr,
} from "./lib/attach-place.ts";

const USAGE = "usage: attach-pr.ts <PR> [--place]";

interface Args {
  ref: PrRef;
  place: boolean;
  created: boolean;
}

function parseArgs(argv: string[]): Args {
  let ref = "";
  let place = false;
  let created = false;
  for (const arg of argv) {
    if (arg === "--place") place = true;
    else if (arg === "--created") created = true;
    else if (arg.startsWith("-") || ref !== "") fail(2, USAGE);
    else ref = arg;
  }
  const parsed = parsePrRef(ref);
  if (parsed === null || (!place && parsed.slug !== null)) fail(2, USAGE);
  return { ref: parsed, place, created };
}

async function attachHere(args: Args): Promise<number> {
  const attached = await attachPr(args.ref.pr, { created: args.created });
  if (attached.skipped !== undefined)
    console.error(`attach-pr: ${attached.skipped}; not attaching`);
  console.log(JSON.stringify(attached));
  return 0;
}

async function place(args: Args): Promise<number> {
  const placement = await placePr(args.ref, process.cwd());
  if (placement.kind === "elsewhere") {
    console.error(placement.message);
    return 3;
  }
  const { tree, pr, created, slug } = placement;
  const attached = await attachIn(tree, pr, created);
  process.stderr.write(attached.stderr);
  if (attached.code !== 0) return attached.code;
  console.log(JSON.stringify({ pr, repo: slug, tree, created }));
  return 0;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  try {
    return await (args.place ? place(args) : attachHere(args));
  } catch (e) {
    if (!(e instanceof AttachRefusal)) throw e;
    console.error(`attach-pr: ${e.message}`);
    return e.code;
  }
}

if (import.meta.main) runMain("attach-pr.ts", main);
