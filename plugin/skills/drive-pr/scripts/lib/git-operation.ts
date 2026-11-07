/** Read unfinished Git operations with the failed command preserved. */
import { resolve } from "node:path";
import type { RunOptions, RunResult } from "./proc.ts";

const UNCONCLUDED_GIT_OP_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "rebase-merge",
  "rebase-apply",
];

/**
 * `process.argv.slice(1)` under a bare `bun -e <script>` is exactly the
 * trailing argv this is invoked with (no `eval`/script-path placeholder
 * occupies a slot) — verified empirically.
 */
const MARKER_PROBE_SCRIPT = `
const { existsSync } = require('node:fs');
const { join } = require('node:path');
const [gitDir, ...markers] = process.argv.slice(1);
for (const m of markers) {
  if (existsSync(join(gitDir, m))) {
    process.stdout.write(m);
    process.exit(0);
  }
}
process.exit(0);
`;

/**
 * Is there an UNCONCLUDED merge, cherry-pick, revert, rebase, or `git am`
 * sitting in this worktree's git directory? `git status --porcelain` — even
 * with an explicit untracked-files mode and `--ignore-submodules=none` —
 * answers "is anything uncommitted", not "is a git operation still open":
 * resolving a conflict back to a tree that matches what was already committed
 * (`git checkout --ours f && git add f`, say) leaves `MERGE_HEAD` behind while
 * porcelain status reports empty. An interactive rebase paused at an `edit`
 * instruction, or a `git am` mid-apply, can likewise leave a clean
 * index/worktree while `rebase-merge`/`rebase-apply` remain — both checked here
 * too.
 *
 * The git-dir resolution runs through the bounded `git()`. A synchronous
 * `existsSync()` in THIS process would have no deadline: on a stalled
 * filesystem it would hang past `GIT_CALL_TIMEOUT` and the caller's fail-closed
 * refusal would never be reached. So the marker check runs as an inline probe
 * (`runInlineProbe`) bounded by `run()`'s deadline, with no shell.
 *
 * `ok: false` means either probe could not complete (an unresolvable
 * git-dir, a timeout, an unreadable filesystem) — fail-closed, the same
 * posture the caller's own unreadable-tree branch already takes, rather than
 * silently treating "cannot confirm" as "confirmed none". `marker` names the
 * offending file/directory's basename, or is `null` when none is present.
 *
 * `opts.cwd`/`opts.env` are for a caller that has already anchored a
 * `root`/sanitized environment of its own (base-sync.ts's — a leaked
 * `GIT_DIR` overrides repository discovery regardless of cwd, so the
 * `--git-dir` read needs the same sanitized env every other call in that
 * caller gets) and needs THIS probe to answer for that same checkout rather
 * than the ambient one. `--git-dir` can answer with a path relative to the
 * directory it ran in, so it is made absolute against that directory before
 * it reaches the probe. Without them the ambient cwd/env are read.
 */
export async function inspectGitOperation(
  timeoutSec: number,
  opts: { cwd?: string; env?: Record<string, string | undefined> } | undefined,
  gitRun: (args: string[], opts: RunOptions) => Promise<RunResult>,
  probeRun: (
    script: string,
    args: string[],
    opts: Omit<RunOptions, "cwd">,
  ) => Promise<RunResult>,
): Promise<
  { ok: true; marker: string | null } | { ok: false; reason: string }
> {
  const dirRes = await gitRun(["rev-parse", "--git-dir"], {
    stderr: "pipe",
    timeoutSec,
    ...opts,
  });
  if (dirRes.code !== 0)
    return {
      ok: false,
      reason: `git rev-parse --git-dir exited ${dirRes.code}: ${dirRes.stderrTail || dirRes.stderr.trim()}`,
    };
  const gitDir = dirRes.stdout.trim();
  if (gitDir === "")
    return {
      ok: false,
      reason: "git rev-parse --git-dir returned no directory",
    };

  const probe = await probeRun(
    MARKER_PROBE_SCRIPT,
    [
      resolve(opts?.cwd ?? process.cwd(), gitDir),
      ...UNCONCLUDED_GIT_OP_MARKERS,
    ],
    { stderr: "pipe", timeoutSec },
  );
  if (probe.code !== 0)
    return {
      ok: false,
      reason: `git operation marker probe exited ${probe.code}: ${probe.stderrTail || probe.stderr.trim()}`,
    };
  const marker = probe.stdout.trim();
  return { ok: true, marker: marker === "" ? null : marker };
}
