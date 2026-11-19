# Follow-up arm: consumer repositories

What a merge into Jig owes the repositories that use it (consumer
repositories, `GLOSSARY.md`). Jig names no consumer in its own content
(AGENTS.md, no origin references), and its configuration lists none: the
repository labels in `review.taxonomy.repos` name only Jig. So this arm never
names a consumer, never brings a consumer's content into Jig, and never
writes to another repository. Anything in another repository, or near the
origin-reference boundary, is a person's decision in the follow-up's
authority table (`other-repository`, `origin-boundary`).

Record one verdict for the arm with the follow-up's `record` command:
`owed` with the item filed here, `not-owed` naming the answers below
(no tool brought in from another repository, no change marked
**Breaking**, no lesson for a consumer's practice), `unread` when the change
notes or the changelog could not be read.

## 1. Move, never copy

When the merge brought a tool in from a consumer repository, deleting the
source's copy in the same rollout is owed there (AGENTS.md, writing
conventions). Read the pull request's description and its out-of-tree
section for the move.

## 2. Breaking changes

A change note of the merge, or the release section it was written into,
that marks a change **Breaking** owes each consumer the action its
**Consumer actions** declare (`changes/README.md`). The release step derives
those into `plugin/consumer-actions.json`.

## 3. Backflow

A lesson the merge learned that a consumer's practice should take, or the
reverse: a practice a consumer has proved that Jig should take, in its
corrected design (AGENTS.md, learning from the repositories that use Jig).
Whether Jig takes a consumer's practice is decided in its own pull request,
not here.

## What to carry out

For each of 1 to 3 that is owed, file one item in Jig's own tracker that
states what a consumer owes, naming none, and record the arm `owed` with it
as a person's step: who takes it to which repository is a person's
decision, and never a question this pass stops on. Before filing, search
for an open item that already carries the same consumer action, and add to
it where one fits.

## Before the merge

In a preview, answer 1 to 3 against the branch and its change notes, and
record what the merge will owe, so the description's out-of-tree section can
carry it.
