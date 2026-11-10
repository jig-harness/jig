import { git, gitCallTimeoutSeconds, unconcludedGitOpMarker } from "./proc.ts";

/**
 * Is the worktree clean, right now? Called at the up-front pass and again at
 * the last possible point before every success path this script can take —
 * never trusted from an earlier call, since real work (a comment sweep, a
 * liveness re-read, an API round-trip) sits between each of those points and
 * an edit can land in that window. `0` means confirmed clean; `1` means dirty
 * or unreadable, with the reason already on stderr — the caller returns it
 * verbatim.
 */
export async function checkWorktreeClean(
  reviewedHead: string,
): Promise<number> {
  // Every check below answers "is the tree clean", never "is this the commit
  // that was reviewed" — and those are different questions. If another
  // process (a concurrent pane, a stray `git commit`) commits a new local
  // change while this script is mid-run — there are several API round-trips
  // between calls, and `drive.ts` similarly runs its handoff helper first —
  // `git status` reads EMPTY (nothing uncommitted) and no unconcluded-op
  // marker is present, so every check below would pass over local HEAD
  // having silently moved from the reviewed commit to an unreviewed one that
  // was never pushed.
  // Checked first, since a HEAD mismatch makes every check below beside the
  // point regardless of what they would have found.
  const headTimeoutSec = gitCallTimeoutSeconds();
  const localHeadRes = await git(["rev-parse", "HEAD"], {
    stderr: "ignore",
    timeoutSec: headTimeoutSec,
  });
  if (localHeadRes.code !== 0) {
    console.error(
      "announce-merge-ready: cannot read the working tree — refusing to announce",
    );
    console.error("without confirming nothing here is still uncommitted.");
    return 1;
  }
  const localHead = localHeadRes.stdout.trim();
  if (localHead !== reviewedHead) {
    console.error(
      `announce-merge-ready: local HEAD is ${localHead}, but the reviewed head is`,
    );
    console.error(
      `${reviewedHead} — a commit landed here that was never pushed or reviewed.`,
    );
    console.error(
      "Refusing to announce. Push it, or reset to the reviewed head, then re-run.",
    );
    return 1;
  }

  // A `git status --porcelain` predicate — however hardened — answers "is
  // anything uncommitted", not "is a git operation still open": resolving a
  // conflict back to a tree that matches what was already committed leaves
  // `MERGE_HEAD` behind while porcelain status reports empty. Checked next,
  // before the status call below, because a marker present makes the status
  // answer beside the point either way.
  const opTimeoutSec = gitCallTimeoutSeconds();
  const op = await unconcludedGitOpMarker(opTimeoutSec);
  if (!op.ok) {
    console.error(
      "announce-merge-ready: cannot read the working tree — refusing to announce",
    );
    console.error("without confirming nothing here is still uncommitted.");
    return 1;
  }
  if (op.marker !== null) {
    console.error(
      `announce-merge-ready: an unconcluded git operation is present (${op.marker}) —`,
    );
    console.error(
      "refusing to announce. Resolve or abort it (git merge/cherry-pick/revert --abort),",
    );
    console.error("then re-run.");
    return 1;
  }

  // `--untracked-files=normal` is explicit, not decorative: `--porcelain` alone
  // inherits `status.showUntrackedFiles` from repo or user config, and `=no`
  // there makes a plain `git status --porcelain` report an untracked scratch
  // file as a clean tree — silently certifying a leftover as shipped. An
  // explicit mode overrides whatever the config says, the same way
  // `--porcelain`'s own stable machine format is chosen over the human one
  // regardless of `status.short`. `--ignore-submodules=none` closes the same
  // class of bypass one level down: `submodule.<name>.ignore`/`.gitmodules` can
  // set `ignore = all` on a tracked submodule, which makes a plain `git status`
  // hide modifications inside it regardless of the untracked-files mode.
  const dirtyRes = await git(
    [
      "status",
      "--porcelain",
      "--untracked-files=normal",
      "--ignore-submodules=none",
    ],
    {
      stderr: "ignore",
      timeoutSec: gitCallTimeoutSeconds(),
    },
  );
  if (dirtyRes.code !== 0) {
    console.error(
      "announce-merge-ready: cannot read the working tree — refusing to announce",
    );
    console.error("without confirming nothing here is still uncommitted.");
    return 1;
  }
  if (dirtyRes.stdout !== "") {
    console.error(
      "announce-merge-ready: review converged, but this worktree still has uncommitted state:",
    );
    process.stderr.write(dirtyRes.stdout);
    console.error(
      "These edits shipped in no round — commit or discard them, then re-run.",
    );
    return 1;
  }

  // Re-read local HEAD once more, immediately before reporting clean. The check
  // at the top of this function narrows the window a commit can land in
  // undetected; it cannot close it, because the operation-marker and status
  // probes above are themselves further elapsed time after that read — a commit
  // landing in that gap leaves `git status` reporting a clean H2 while this
  // function was about to vouch for reviewed H1. This is the same "narrows,
  // does not close, so re-check at the latest possible point" treatment
  // `retractStale`'s own comment describes for the analogous PR head race —
  // applied here to the LOCAL head instead.
  const finalHeadRes = await git(["rev-parse", "HEAD"], {
    stderr: "ignore",
    timeoutSec: headTimeoutSec,
  });
  if (finalHeadRes.code !== 0) {
    console.error(
      "announce-merge-ready: cannot read the working tree — refusing to announce",
    );
    console.error("without confirming nothing here is still uncommitted.");
    return 1;
  }
  const finalHead = finalHeadRes.stdout.trim();
  if (finalHead !== reviewedHead) {
    console.error(
      `announce-merge-ready: local HEAD is ${finalHead}, but the reviewed head is`,
    );
    console.error(
      `${reviewedHead} — a commit landed here during this check that was never pushed`,
    );
    console.error(
      "or reviewed. Refusing to announce. Push it, or reset to the reviewed head,",
    );
    console.error("then re-run.");
    return 1;
  }
  return 0;
}
