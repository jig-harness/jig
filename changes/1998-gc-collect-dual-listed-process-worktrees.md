---
release: patch
---

### Fixed

- `jig gc` collects a process-runtime worktree that Orca also lists. Orca lists every Git worktree of a repository whose external worktrees it shows, so on a host with both runtimes such worktrees were always kept as unverified ("also listed by Orca") and piled up with every dispatched run. A process-owned worktree is now collectible when the process owner's evidence and Orca's registry both say it is finished: every launch that names it has ended with its recorded processes dead, and Orca shows no agent at work and no live terminal in it. A registry that cannot be read, or a terminal whose agents Orca cannot report, keeps the worktree as unverified and the reason names Orca. Git state, pull request, ignored content, process holders and idleness are checked as before, so a worktree with uncommitted work or unpushed commits is still kept. See [gc's process runtime section](../plugin/gc/README.md).
