# review-reflections

**What problem this solves.** Findings that sessions record with
[`/jig:reflect`](../reflect/README.md) are only worth something once they
change the scaffolding: an instruction rewritten, a gate added, a reviewer
configured. Without a review step they pile up in the store, the same class of
problem keeps being recorded, and nobody can say which lessons were acted on.
`/jig:review-reflections` is that step: it groups what recurred, proposes a
change for each group, has a person approve every change, and records what was
decided, so a fix counts as done only once it is merged. The agent's procedure
is in [SKILL.md](SKILL.md).

## What it reviews

The findings the repository it runs in would fix:

- those about its own scaffolding (`target.scope: repository`, recorded in
  this repository);
- when the repository is a tool (it holds a `.claude-plugin` or
  `.codex-plugin` manifest, at its root or under `plugin/`), every finding
  about that tool, from every repository that uses it. Run in the Jig
  repository, it sees the findings about Jig's skills from every repository
  that reflected into the same store.

`--class`, `--target`, `--severity` and `--since` narrow it.

## The steps

1. **Reconcile.** An `approved` finding whose commit is now reachable from the
   integration branch (`repository.base_branch`, else `origin`'s default
   branch) gets an `implemented` decision. A squash merge is followed through
   the pull request's merge commit. A check that cannot be completed (the
   remote unreachable, a pull request that cannot be read, a commit the clone
   lacks) leaves the finding `approved` and is reported; it is never read as
   "not merged". A failed fetch stops the reconcile, so a network error never
   makes a merged fix look unmerged.
2. **Load** the store and `diagnose` it, and **group** the open findings by
   owner, class and target, the most recurrent first, with counts. A group's
   count is how often the problem recurred.
3. **Propose** an action per group: a concrete change to a named file, a
   deferral, a dismissal with its reason, or an escalation.
4. **Approve.** A person approves, edits or rejects each proposal. Nothing is
   changed without approval.
5. **Escalate** a class at `reflection.escalate_after` occurrences to one
   tracker issue, as [reflect's escalation](../reflect/README.md#escalation)
   does, for the owners in scope: run in the Jig repository, it escalates
   findings about Jig's skills to Jig's tracker. A class's issue is the one
   carrying that owner's
   [owner marker](https://github.com/docomply/jig/blob/main/GLOSSARY.md) in
   its description, and a newly filed issue gets the marker the plan names; an
   issue without it, such as one filed before the marker existed, is not
   attached to, and the next escalation files a new one.
6. **Implement** the approved changes in a pull request, and **record** a
   decision event per finding: `approved` with the commit and pull request, or
   the disposition and its reason.

## Script

`scripts/review.ts` (`load`, `reconcile`, `plan`, `escalate`, `record`) is the
script half. It reads the store through the same client and configuration as
`reflect` ([configuration](../../CONFIGURATION.md#reflection)); with
reflection off it does nothing.
