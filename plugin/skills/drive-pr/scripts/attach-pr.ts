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
 *   attach-pr.ts <PR> --created       as the first form, recording that the
 *                                     tree was created for the drive (what
 *                                     `--place` passes for a tree it made)
 *
 * Prints one JSON line on success: `{pr, branch, remote, head, worktree,
 * detached, created}` for an attach, `{pr, repo, tree, created, otherClone,
 * env}` for `--place`; `otherClone` says the tree is in another clone, and
 * `env.unset` (`destinationEnv` in `lib/attach-place.ts`) names the variables
 * the attach ran without, which every later process in that tree drops too.
 * A tree `--place` creates is recorded as the PR's before the attach runs, so
 * a failed or interrupted attach leaves a tree the next `--place` reuses. `drive.ts` attaches once it holds the tree's lock and the
 * pull request's, so arming a drive runs this either way; `--place` is the arm step's, which needs to know the
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
 *  11  a live driver holds this working tree or the PR: nothing moved
 */
import { fail, runMain } from "./lib/cli.ts";
import { AttachRefusal, attachOff, attachPr } from "./lib/attach.ts";
import {
  attachIn,
  type PrRef,
  parsePrRef,
  placePr,
} from "./lib/attach-place.ts";

const USAGE = "usage: attach-pr.ts <PR> [--place | --created]";

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
  console.log(JSON.stringify(attached));
  if (attached.skipped === undefined) return 0;
  console.error(`attach-pr: ${attached.skipped}; not attaching`);
  return 11;
}

async function place(args: Args): Promise<number> {
  // Read before placement, which can create a tree: an invalid switch
  // refuses before anything is done.
  const off = attachOff("attach-pr.ts");
  const placement = await placePr(args.ref, process.cwd());
  if (placement.kind === "elsewhere") {
    console.error(placement.message);
    return 3;
  }
  const { tree, pr, created, slug, otherClone, env } = placement;
  // `DRIVE_PR_ATTACH=off` drives the chosen tree as it stands, as drive.ts
  // does: a tree placement made is already at the head.
  if (!off) {
    const attached = await attachIn(tree, pr, created, env);
    process.stderr.write(attached.stderr);
    if (attached.code !== 0) return attached.code;
  }
  console.log(
    JSON.stringify({ pr, repo: slug, tree, created, otherClone, env }),
  );
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
