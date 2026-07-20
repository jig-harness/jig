# Branch discipline

> A short, importable block for an agent instruction file (see the M0
> instruction-architecture module). It exists because parallel agents on one
> repo create the two branch-level collisions no single agent can see: two
> agents opening divergent branches for the same task, and shared-state moves
> that quietly cross worktrees. Paste it in and trim to your repo.

## Reuse before create

**Before creating a branch, look for an existing one and reuse it. Only create a
branch when none exists for the task.**

```sh
# Reuse the branch if it exists locally or on the remote; else create it.
branch="feature/short-slug"                 # derive from the task/ticket id
git fetch --quiet origin "$branch" 2>/dev/null || true
if git show-ref --verify --quiet "refs/heads/$branch"; then
  git switch "$branch"                      # local branch exists — reuse
elif git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  git switch --track "origin/$branch"       # remote branch exists — track it
else
  git switch -c "$branch" || git switch "$branch"   # create — or reuse if another worktree just made it
fi
```

Why: two agents given the same task will otherwise each run `git switch -c` and
produce two divergent `feature/short-slug` branches that later fight to merge.
Deriving the name from a stable task/ticket id and reusing makes concurrent
agents converge on one branch.

## Footgun bans (checklist)

Short, each with its reason — a rule with a rationale survives; a bare "don't"
gets worked around.

- [ ] **No `git stash` to move work between worktrees.** The stash stack is
      shared across all worktrees of a repo, so a stash pushed in one can be
      popped in another and silently mix or lose changes. Commit (even a WIP
      commit) or use a per-worktree patch file instead.
- [ ] **No root install with the wrong package manager.** Installing at the
      repo root with a manager the repo doesn't use rewrites the shared lockfile
      and hoists a divergent dependency tree that every other worktree then trips
      over. Use the repo's declared package manager only.
- [ ] **No `git config --global` mid-session.** It leaks into every worktree and
      every other agent. Use `--local` (per-worktree where supported) or `-c
      key=val` for a single command.
- [ ] **No force-push to a shared branch another agent may be on.** Coordinate or
      branch instead; a force-push rewrites history under a concurrent worktree.

Keep the list to real incidents for your repo. Each item is a collision that
only appears when more than one agent shares the machine — which is exactly the
condition this module treats as normal.
