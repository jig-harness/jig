#!/usr/bin/env bun
/**
 * Make the Orca workspace this session runs in point at the pull request it
 * drove, when the session runs in one; do nothing anywhere else.
 *
 * Usage: bun workspace-pr-link.ts <PR>
 *
 * Orca (https://www.onorca.dev) links a workspace to a pull request and shows
 * the link on its card. A workspace opened before the pull request, or
 * re-pointed at another one since, carries no link or the wrong one. The
 * drive's announcement of merge-readiness calls this first, so the card a
 * person opens to merge shows the pull request the drive converged. It reads
 * the workspace's link (`orca worktree current`) and sets it only when it
 * differs.
 *
 * The caller runs it only in the worktree that drove the pull request. Like
 * `orca-board.ts` it acts only in a terminal Orca opened whose worktree Orca
 * knows, and every Orca failure only warns and the exit is 0; only a
 * malformed command line exits 2.
 */
import { fail, isDigits, runMain } from "../../../shared/cli.ts";
import {
  type OrcaRunner,
  orcaCommand,
  orcaEnvelope,
  orcaFailure,
  orcaResult,
  runOrca,
} from "../../../shared/orca.ts";

const USAGE = "usage: workspace-pr-link.ts <PR>";

export function parseArgs(args: string[]): string {
  const [pr, ...extra] = args;
  if (pr === undefined || !isDigits(pr) || extra.length > 0) fail(2, USAGE);
  return pr;
}

/** The error code Orca answers with when no worktree contains the directory. */
const NOT_A_WORKTREE = "selector_not_found";

/** Point the working directory's workspace at `pr`; returns the line to report. */
export async function linkWorkspacePr(
  pr: string,
  env: Record<string, string | undefined> = process.env,
  runner: OrcaRunner = runOrca,
): Promise<string> {
  const command = orcaCommand(env);
  if (command === null) return "workspace-pr-link: not in Orca; nothing to do";
  const current = await runner(command, ["worktree", "current", "--json"]);
  const worktree = orcaResult(current)?.worktree as
    | { id?: unknown; linkedPR?: unknown }
    | undefined;
  if (typeof worktree?.id !== "string" || worktree.id === "") {
    const envelope = orcaEnvelope(current.stdout);
    if (envelope?.ok === false && envelope.code === NOT_A_WORKTREE)
      return "workspace-pr-link: Orca does not list this directory as a worktree; nothing to do";
    return `workspace-pr-link: ⚠ could not ask Orca which worktree this is ${orcaFailure(current)}`;
  }
  if (String(worktree.linkedPR) === pr)
    return `workspace-pr-link: already linked to PR #${pr}`;
  const done = await runner(command, [
    "worktree",
    "set",
    "--worktree",
    `id:${worktree.id}`,
    "--pr",
    pr,
    "--json",
  ]);
  if (orcaResult(done) === null)
    return `workspace-pr-link: ⚠ could not link the workspace to PR #${pr} ${orcaFailure(done)}`;
  const was =
    worktree.linkedPR === null || worktree.linkedPR === undefined
      ? "no link"
      : `PR #${String(worktree.linkedPR)}`;
  return `workspace-pr-link: linked to PR #${pr} (was ${was})`;
}

if (import.meta.main)
  runMain("workspace-pr-link", async () => {
    console.error(await linkWorkspacePr(parseArgs(process.argv.slice(2))));
    return 0;
  });
