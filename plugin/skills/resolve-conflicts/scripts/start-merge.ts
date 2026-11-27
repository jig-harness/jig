#!/usr/bin/env bun
/**
 * Merge a pull request's base into its branch, the first step of bringing a
 * branch up to date (drive-pr's conflict-resolve round included).
 *
 * Usage: bun start-merge.ts --base <branch> [--remote <remote>] [--pr <number>] [--json]
 *   Run from inside the repository, on the pull request's branch, after
 *   fetching `<remote>/<base>`. `--remote` defaults to the repository's
 *   configured remote; `--pr` to `$DRIVE_PR_TARGET`, then to the pull
 *   request of the checked-out branch.
 *
 * When the pull request was stacked on another branch that has since landed
 * on `<base>` by squash or rebase (`lib/earlier-base.ts`), the merge takes
 * the point where this branch left that earlier base as its merge base, so
 * the earlier base's own changes, present on both sides under different
 * commits, cannot conflict. The prepared merge message says so and carries
 * the base as a `Merge-base:` line, which `conflict-map.ts` reads and the
 * merge commit keeps. Otherwise it runs git's own merge, as
 * `git merge <remote>/<base>` would. Either way conflicts are written with a
 * base section (`merge.conflictStyle=zdiff3`). A forge that cannot be read
 * leaves git's own merge, and the report says why.
 *
 * Exit codes: 0 merged and committed; 9 stopped on conflicts, the merge left
 * open for resolution; 3 refused before touching anything (an operation
 * already open, staged changes, or local changes git would overwrite); 1 a
 * step failed (the report names it); 2 usage, or not inside a git work tree.
 * `--json` prints the report on stdout; the prose goes to stderr either way.
 */
import { existsSync, writeFileSync } from "node:fs";
import { fail, runMain } from "../../../shared/cli.ts";
import { readRemoteName } from "../../../shared/consumer.ts";
import { resolvePr } from "../../drive-pr/scripts/lib/proc.ts";
import {
  askForge,
  type AskForge,
  type Landing,
  mergeBaseAfter,
  readLanding,
} from "./lib/earlier-base.ts";
import { gitPath, gitRaw, resolveCommit, topLevel } from "./lib/git.ts";

export const START_MERGE_SCHEMA = "start-merge/v1";

export interface StartMergeInput {
  root: string;
  remote: string;
  base: string;
  /** The pull request, or null when none is known. */
  pr: number | null;
  ask: AskForge;
}

export interface StartMergeReport {
  schema: typeof START_MERGE_SCHEMA;
  outcome: "merged" | "conflicts" | "refused" | "failed";
  /** `earlier-base` when the merge base was where this branch left its earlier base. */
  mode: "git" | "earlier-base";
  head: string | null;
  theirs: string | null;
  /** The merge base the merge used; null for git's own. */
  mergeBase: string | null;
  earlierBase: Landing | null;
  /** Why the earlier base did not set the merge base, when it did not. */
  detection: string | null;
  /** The unmerged paths a conflicted merge left. */
  conflicts: string[];
  reason: string;
}

const OPEN_OPERATIONS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];

const EXIT: Record<StartMergeReport["outcome"], number> = {
  merged: 0,
  conflicts: 9,
  refused: 3,
  failed: 1,
};

function report(
  fields: Partial<StartMergeReport> &
    Pick<StartMergeReport, "outcome" | "reason">,
): StartMergeReport {
  return {
    schema: START_MERGE_SCHEMA,
    mode: "git",
    head: null,
    theirs: null,
    mergeBase: null,
    earlierBase: null,
    detection: null,
    conflicts: [],
    ...fields,
  };
}

function unmerged(root: string): string[] {
  const r = gitRaw(root, ["diff", "--name-only", "--diff-filter=U", "-z"]);
  return r.code === 0 ? r.stdout.split("\0").filter(Boolean) : [];
}

function openOperation(root: string): string | null {
  return (
    OPEN_OPERATIONS.find((name) => existsSync(gitPath(root, name))) ?? null
  );
}

/** Which merge base to use: the earlier base's, or why git's own. */
async function chooseBase(
  input: StartMergeInput,
  head: string,
  theirs: string,
): Promise<
  | { base: string; landing: Landing }
  | { base: null; landing: Landing | null; detection: string }
> {
  if (input.pr === null)
    return {
      base: null,
      landing: null,
      detection: "no pull request is known for this branch",
    };
  const landing = await readLanding(input.ask, input.pr, input.base);
  if (!landing.ok)
    return {
      base: null,
      landing: null,
      detection: `the forge could not say what #${input.pr} was based on: ${landing.failure.reason}`,
    };
  if (landing.value === null)
    return {
      base: null,
      landing: null,
      detection: `#${input.pr} was not retargeted onto ${input.base} from a branch that has merged there`,
    };
  const base = mergeBaseAfter(
    input.root,
    input.remote,
    head,
    theirs,
    landing.value,
  );
  return base.ok
    ? { base: base.value, landing: landing.value }
    : { base: null, landing: landing.value, detection: base.failure.reason };
}

/** The message git would prepare, with the earlier base and the merge base recorded. */
function preparedMessage(
  root: string,
  ref: string,
  base: string,
  landing: Landing,
  mergeBase: string,
): string {
  const branch = gitRaw(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const into = branch.code === 0 ? ` into ${branch.stdout.trim()}` : "";
  return [
    `Merge remote-tracking branch '${ref}'${into}`,
    "",
    `The earlier base ${landing.ref} landed on ${base} as ${landing.landed.slice(0, 12)} (#${landing.pr}), so this merge compared this branch's own changes since it left ${landing.ref} with ${base}'s.`,
    "",
    `Merge-base: ${mergeBase}`,
    "",
  ].join("\n");
}

/** Run git's own merge of `ref`. */
function gitMerge(
  root: string,
  ref: string,
  head: string,
  theirs: string,
  detection: string,
  landing: Landing | null,
): StartMergeReport {
  const r = gitRaw(
    root,
    ["-c", "merge.conflictStyle=zdiff3", "merge", "--no-edit", ref],
    undefined,
    { ...process.env, GIT_MERGE_AUTOEDIT: "no" },
  );
  const fields = { head, theirs, detection, earlierBase: landing };
  if (r.code === 0)
    return report({ ...fields, outcome: "merged", reason: `merged ${ref}` });
  const conflicts = unmerged(root);
  if (conflicts.length > 0)
    return report({
      ...fields,
      outcome: "conflicts",
      conflicts,
      reason: `the merge of ${ref} stopped on conflicts`,
    });
  const said = `${r.stderr}${r.stdout}`.trim();
  return openOperation(root) === null
    ? report({
        ...fields,
        outcome: "refused",
        reason: `git merge refused (exit ${r.code}): ${said}`,
      })
    : report({
        ...fields,
        outcome: "failed",
        reason: `git merge exited ${r.code} with the merge open and no conflict: ${said}`,
      });
}

/** Merge `theirs` into HEAD with `mergeBase`, leaving git's own merge state behind. */
function mergeWithBase(
  root: string,
  ref: string,
  base: string,
  head: string,
  theirs: string,
  mergeBase: string,
  landing: Landing,
): StartMergeReport {
  const fields = {
    mode: "earlier-base" as const,
    head,
    theirs,
    mergeBase,
    earlierBase: landing,
  };
  if (gitRaw(root, ["diff", "--cached", "--quiet"]).code !== 0)
    return report({
      ...fields,
      outcome: "refused",
      reason: "the index holds staged changes; commit or unstage them first",
    });
  const r = gitRaw(
    root,
    [
      "-c",
      "merge.conflictStyle=zdiff3",
      "merge-recursive",
      mergeBase,
      "--",
      "HEAD",
      theirs,
    ],
    undefined,
    { ...process.env, [`GITHEAD_${theirs}`]: ref },
  );
  if (r.code !== 0 && r.code !== 1)
    return report({
      ...fields,
      outcome: "refused",
      reason: `git merge-recursive refused (exit ${r.code}): ${`${r.stderr}${r.stdout}`.trim()}`,
    });
  // What `git merge` itself leaves: the merged commit, the message, the
  // previous HEAD. `git commit` concludes it and `git merge --abort` ends it.
  gitRaw(root, ["update-ref", "ORIG_HEAD", head]);
  writeFileSync(gitPath(root, "MERGE_HEAD"), `${theirs}\n`);
  writeFileSync(gitPath(root, "MERGE_MODE"), "");
  writeFileSync(
    gitPath(root, "MERGE_MSG"),
    preparedMessage(root, ref, base, landing, mergeBase),
  );
  const conflicts = unmerged(root);
  if (r.code === 1 || conflicts.length > 0)
    return report({
      ...fields,
      outcome: "conflicts",
      conflicts,
      reason: `the merge of ${ref} stopped on conflicts in this branch's own changes`,
    });
  const commit = gitRaw(root, ["commit", "--quiet", "--no-edit"], undefined, {
    ...process.env,
    GIT_MERGE_AUTOEDIT: "no",
  });
  return commit.code === 0
    ? report({ ...fields, outcome: "merged", reason: `merged ${ref}` })
    : report({
        ...fields,
        outcome: "failed",
        reason: `the merge applied cleanly but git commit exited ${commit.code}, so the merge is still open: conclude it with git commit, or end it with git merge --abort. ${`${commit.stderr}${commit.stdout}`.trim()}`,
      });
}

/** Merge `<remote>/<base>` into the checked-out branch, choosing the merge base. */
export async function startMerge(
  input: StartMergeInput,
): Promise<StartMergeReport> {
  const { root, remote, base } = input;
  const ref = `${remote}/${base}`;
  const open = openOperation(root);
  if (open !== null)
    return report({
      outcome: "refused",
      reason: `a git operation is already open (${open}); finish or abort it first`,
    });
  const head = resolveCommit(root, "HEAD");
  const theirs = resolveCommit(root, `refs/remotes/${ref}`);
  if (head === null || theirs === null)
    return report({
      outcome: "failed",
      head,
      theirs,
      reason:
        head === null
          ? "HEAD does not name a commit"
          : `${ref} does not name a commit; fetch it first`,
    });
  const chosen = await chooseBase(input, head, theirs);
  return chosen.base === null
    ? gitMerge(root, ref, head, theirs, chosen.detection, chosen.landing)
    : mergeWithBase(root, ref, base, head, theirs, chosen.base, chosen.landing);
}

function parseArgs(argv: string[]): {
  base: string;
  remote: string | null;
  pr: string | null;
  json: boolean;
} {
  let base = "";
  let remote: string | null = null;
  let pr: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined || next === "")
        fail(2, `start-merge: ${arg} needs a value`);
      return next;
    };
    if (arg === "--json") json = true;
    else if (arg === "--base") base = value();
    else if (arg === "--remote") remote = value();
    else if (arg === "--pr") pr = value().replace(/^#/, "");
    else fail(2, `start-merge: unknown argument ${arg}`);
  }
  if (base === "") fail(2, "start-merge: --base <branch> is required");
  if (pr !== null && !/^[1-9]\d*$/.test(pr))
    fail(2, `start-merge: --pr takes a pull request number, not ${pr}`);
  return { base, remote, pr, json };
}

function describe(r: StartMergeReport): string[] {
  const lines = [`start-merge: ${r.outcome}: ${r.reason}`];
  if (
    r.mode === "earlier-base" &&
    r.earlierBase !== null &&
    r.mergeBase !== null
  )
    lines.push(
      `  merge base: ${r.mergeBase.slice(0, 12)}, where this branch left ${r.earlierBase.ref} (landed by #${r.earlierBase.pr} as ${r.earlierBase.landed.slice(0, 12)})`,
    );
  else if (r.detection !== null)
    lines.push(`  merge base: git's own (${r.detection})`);
  for (const path of r.conflicts) lines.push(`  conflict: ${path}`);
  return lines;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const root = topLevel();
  if (root === null) fail(2, "start-merge: not inside a git work tree.");
  let remote = args.remote;
  if (remote === null) {
    const configured = readRemoteName(root);
    if ("error" in configured) fail(2, `start-merge: ${configured.error}`);
    remote = configured.remote;
  }
  const named = args.pr ?? process.env.DRIVE_PR_TARGET ?? "";
  const pr = await resolvePr(named, root);
  const result = await startMerge({
    root,
    remote,
    base: args.base,
    pr: /^[1-9]\d*$/.test(pr) ? Number(pr) : null,
    ask: askForge(root),
  });
  for (const line of describe(result)) console.error(line);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  return EXIT[result.outcome];
}

if (import.meta.main) runMain("start-merge", main);
