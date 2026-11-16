/**
 * What the release arm reads, in one command: the change notes the merge
 * added, edited or renamed into place, whether each still waits on the
 * integration branch, and the changelog skill's `status.ts` report read
 * from a throwaway checkout of that branch (the working tree is the branch
 * `status.ts` reads, and a follow-up's workspace holds the merged branch).
 *
 * A note is still waiting when its file is on the integration branch and
 * its last addition there is the same commit as its last addition at the
 * merge, the way the release step dates a note: a note the merge only
 * edited is still the note it edited, while a file name a release deleted
 * can be reused, and a later merge's note is that merge's.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attempt } from "../../../../shared/outcome.ts";
import type { RunResult } from "../../../../shared/proc.ts";
import { isNoteFile } from "../../../changelog/scripts/notes-dir.ts";
import type { DiffRange, GitRunner } from "./facts.ts";

/** One note of the merge. */
export interface MergeNote {
  file: string;
  /** Whether it still waits for a release on the integration branch. */
  waiting: boolean;
}

/** What `status.ts` printed, or why it printed nothing. */
export interface StatusRead {
  exit: number;
  /** Its JSON report; null when it printed none. */
  report: unknown;
  stderr: string;
}

/** Whether `path` is a note, by the changelog skill's own definition, which the release step reads. */
export function isNote(path: string, dir: string): boolean {
  return isNoteFile(dir, path);
}

/** The commit that last added `path` on the first-parent line of `ref`; null when none did. */
async function lastAdded(
  git: GitRunner,
  ref: string,
  path: string,
): Promise<{ sha: string | null; error: string | null }> {
  const r = await git([
    "log",
    "--first-parent",
    "--diff-filter=A",
    "-1",
    "--format=%H",
    ref,
    "--",
    path,
  ]);
  if (r.code !== 0)
    return {
      sha: null,
      error: `git log of ${path} on ${ref} exited ${r.code}`,
    };
  const sha = r.stdout.trim();
  return { sha: sha !== "" ? sha : null, error: null };
}

/** The merge's notes, each with whether it still waits on `integrationRef`. */
export async function mergeNotes(
  git: GitRunner,
  range: DiffRange,
  notesDir: string,
  integrationRef: string,
): Promise<{ notes: MergeNote[]; error: string | null }> {
  const r = await git([
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=AMR",
    range.base,
    range.head,
    "--",
    notesDir,
  ]);
  if (r.code !== 0)
    return { notes: [], error: `git diff of the notes exited ${r.code}` };
  const files = r.stdout
    .split("\0")
    .filter((f) => f !== "" && isNote(f, notesDir));
  const notes: MergeNote[] = [];
  for (const file of files) {
    // ls-tree exits 0 with no output for a file the branch lacks; a nonzero exit is an unread state.
    const onBranch = await git([
      "ls-tree",
      "--name-only",
      integrationRef,
      "--",
      file,
    ]);
    if (onBranch.code !== 0)
      return {
        notes: [],
        error: `git ls-tree of ${file} on ${integrationRef} exited ${onBranch.code}`,
      };
    const there =
      onBranch.stdout.trim() !== ""
        ? await lastAdded(git, integrationRef, file)
        : { sha: null, error: null };
    const atMerge = await lastAdded(git, range.head, file);
    const failed = there.error ?? atMerge.error;
    if (failed !== null) return { notes: [], error: failed };
    notes.push({
      file,
      waiting: there.sha !== null && there.sha === atMerge.sha,
    });
  }
  return { notes, error: null };
}

/** What runs `status.ts` in a checkout: its exit and output. */
export type StatusRunner = (checkout: string) => Promise<RunResult>;

/** `status.ts --json` run in a throwaway checkout of `integrationRef`, removed whatever it did. */
export async function statusInCheckout(
  git: GitRunner,
  integrationRef: string,
  status: StatusRunner,
): Promise<StatusRead> {
  const parent = mkdtempSync(join(tmpdir(), "jig-followup-"));
  const checkout = join(parent, "checkout");
  try {
    const added = await git([
      "worktree",
      "add",
      "--detach",
      checkout,
      integrationRef,
    ]);
    if (added.code !== 0)
      return {
        exit: added.code,
        report: null,
        stderr: `a checkout of ${integrationRef} could not be made: ${added.stderrTail.trim()}`,
      };
    const r = await status(checkout);
    const parsed = attempt("invalid", "status.ts's report", (): unknown =>
      JSON.parse(r.stdout),
    );
    const report = parsed.ok ? parsed.value : null;
    return { exit: r.code, report, stderr: r.stderr.trim() };
  } finally {
    await git(["worktree", "remove", "--force", checkout]);
    rmSync(parent, { recursive: true, force: true });
  }
}
