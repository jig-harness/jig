# work-batch: several small issues, one pull request

Run these commands in Bash or PowerShell with Bun, Git and GitHub CLI
available to the command tool. Write tracker bodies and intent input with the
file-writing tool, then pass file paths; branch names are read from the
policy command output.

**What problem this solves.** Most of the cost of a pull request is its
review: the rounds of reviewer comments, the fixes, the waits for continuous
integration (CI). That cost is paid per pull request, not per line. A team
that opens one pull request for each small issue pays it again for each one,
and small issues often arrive faster than that pace can close them. Running
several of those pull requests at once over the same files does not help:
they conflict with each other. Without batching, the backlog of small issues
grows, or it turns into merge conflicts. With it, an agent groups several
small, independent issues from one area of the code into one pull request,
with one commit for each issue. The batch then goes through review once, and
five closures cost about what one costs.

`/jig:work-batch` is that practice as a skill. The agent's procedure is
[SKILL.md](SKILL.md); the constraints and their reasons are in
[references/batch-policy.md](references/batch-policy.md).

Contents: [the procedure](#the-procedure) · [anchors](#anchors) ·
[solo-only issues](#solo-only-issues) · [batch size](#batch-size) ·
[ranking](#ranking) · [tracker reads](#tracker-reads) ·
[configuration](#configuration) · [after the merge](#after-the-merge) ·
[evidence](#evidence) · [the eligibility mode](#the-eligibility-mode) ·
[left out](#left-out)

## The procedure

1. **Propose.** A script takes a [batch anchor](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (an area
   of the code, a path, an epic or one issue; see [anchors](#anchors)), reads
   the open issues that match it, holds back every issue that may not join a
   batch, ranks the rest and fills a batch up to a [size budget](#batch-size).
   It prints the proposed batch, the issues it held back with the reason for
   each, and the matching issues that carry no size label at all (a
   labelling gap, which would otherwise make an area look empty).
2. **Check.** The agent reads each proposed issue in full (description and
   comments) and confirms what the script cannot: the issues are
   independent of each other, none is larger than its size label says, and
   each `medium` issue gets an explicit decision: re-size it,
   keep it, or leave it for its own pull request.
3. **Claim.** Just before claiming, the agent runs the proposal again and
   drops any issue whose state, assignee, priority, size, type, context or
   flags changed since the first run: a new flag or an urgent priority holds
   the issue back on the re-run, and the rest are on its revalidation line.
   It compares ids, not names: a state or a person can be renamed, and two
   can share a name. It then moves each issue to
   `in_progress`, assigns itself and comments on each one, naming the other
   issues in the batch. It records each issue's state and assignee as they
   were before the claim, for a release in step 4, and writes the batch form
   of the [intent chain](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md).
4. **Implement.** One commit for each issue, each one validated before it is
   committed. A bug gets the same sibling scout `do-item` runs for a single
   bug. When the batch has grown past its budget after implementing, it is
   trimmed: the lowest-ranked issues and their commits come out; each is
   released (back to the state and assignee recorded at the claim, unless
   someone else changed them since, which the agent reports instead) with a
   comment saying why; when nothing remains, the session's intent-chain copy
   is removed, no pull request opens and the released issues are reported;
   otherwise the highest-ranked remaining issue becomes the anchor when the
   anchor left, the intent chain is rewritten for what remains, and every
   remaining issue gets a comment naming the batch as it now stands.
5. **Open one pull request** through `do-item`'s pull-request policy. Its
   body carries a table with one row for each issue: `Closes <key>`, the
   issue's commits, and what changed. The per-issue `Closes` line is what
   closes each issue on merge.
6. **Drive it once** with [`/jig:drive-pr`](../drive-pr/README.md): one drive
   covers every issue.

## Anchors

| Anchor | Pool |
|--------|------|
| Change-area name | Open issues carrying a label that names the area, and a batchable size label |
| Path in the repository | The same, for each area the path belongs to |
| Epic | The epic's open children |
| One issue | Open issues sharing its area-naming label; the issue itself is kept first when it is eligible, and an ineligible one ends the proposal with a recommendation to work it alone |

The area and path anchors read the [change-area catalog](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
(`drive.change_areas_catalog`): the same `tracker.labels` that label an issue
for an area define which issues belong to it, so there is one answer, not a
second hand-kept list. A path belongs to the areas whose own `paths` match it
directly, not the areas they imply. An area whose own `tracker.flags` include
a solo-only flag cannot be an anchor: every change there carries the flag, so
no batch is possible.

An area's labels can include shared ones, such as a broad domain label that
several areas carry. Only a label that names the area itself narrows the
pool; the others add to an issue's rank. Which labels name an area is
already configured: `do_item.agents.codearea_areas` maps a label to the area
it routes to. When an area has no such label, its shared labels would select
issues from unrelated areas, and the script refuses the anchor instead of
proposing a batch of unrelated issues.

## Solo-only issues

A [solo-only issue](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) never joins a batch. Its
[sensitivity flag](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) starts a review gate or a human step
that applies to the whole pull request: a database migration review, an
interface-contract review, a privacy review, a manual operation after merge,
or a decision that is a human's to make ([HITL](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)). In a
batch, that gate would run over five unrelated changes, or all six issues
would wait for the one human.

The label names are each repository's values, so the list is derived, and
configuration can only add to it:

- the labels `issue_tracker.labels.hitl` (and its facets) and
  `issue_tracker.labels.manual_ops` name;
- every label any area's `tracker.flags` names in the change-area catalog,
  since a catalog flag exists to start a gate;
- `work_batch.solo_flags`, for flags the catalog does not project (a privacy
  label applied by hand, for example).

No setting removes a label the first two sources supply.

Every other read that cannot be completed holds the issue back rather than
admitting it. An issue whose label list came back truncated is held back,
because a solo-only flag could be on the part that was not read. An issue
with no size label, no type label, or only context or area labels the
configuration does not know is held back too, with a reason that says which label to add. The issue is not dropped
without a word.

Provenance labels are not sensitivity flags. An issue filed from a review
finding (`issue_tracker.labels.followup`) is already-owed work, already
scoped, and it ranks *higher*.

## Batch size

A batch has two limits, applied in one pass down the ranked list: take each
issue that still fits both, skip (do not stop at) one that does not.

- **Points** (the main limit). Each size costs points: `xs` 1, `small` 2,
  `medium` 6, against a budget of 16. At those numbers at most two `medium`
  issues fit, and a batch of only `xs` and `small` issues reaches the item
  limit first.
- **Items** (the second limit), 6 by default. Points do not limit how many
  separate concerns one review round must hold; this does.
- **Changed lines**, checked after implementing, since the diff does not
  exist when the batch is proposed. It reads `pull_requests.size_budget`
  when the repository sets one.

## Ranking

The proposal fills the batch in rank order. An issue's score is the sum of:

- the weight of its size label, so that cheaper issues come first;
- the weight of the follow-up label, when it carries it;
- the weight of each shared area label it carries, so an issue that touches
  the anchor's wider domain ranks above one that only names the area.

Higher scores come first. Ties go to the tracker's priority (urgent first,
no priority last), then to the older issue, then to the issue key in text
order, so the input order never decides which issue fits the budget. The
defaults are size `{xs: 2, small: 1, medium: 0}`, `3` for the follow-up label
and `1` for a shared area label; `work_batch.ranking` replaces any of them.
The skill's tests pin these defaults, so a repository that sets nothing gets
the same order on every machine.

## Tracker reads

The proposal reads the tracker only through the
[tracker interface](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md): open issues filtered by several
label conditions, the open children of an issue, and one issue in the same
form. Each result carries what eligibility and ranking read: priority,
creation time, the state and the assignee with their ids, every label,
whether the issue has open children, and which nested lists were truncated.
A pool is read to the end or the read fails, and it is scoped to the
configured team on Linear (`issue_tracker.team`) or the configured repository
on GitHub Issues; an empty label condition is refused, since it would widen
the pool to every open issue.

## Configuration

The `work_batch` section, in [CONFIGURATION.md](../../CONFIGURATION.md#work_batch):

| Field | Default | What it does |
|-------|---------|--------------|
| `work_batch.point_budget` | `16` | The main limit |
| `work_batch.size_points` | `{xs: 1, small: 2, medium: 6}` | Points each batchable size costs; its keys must be exactly `issue_tracker.labels.batch_sizes` |
| `work_batch.max_items` | `6` | The item limit |
| `work_batch.solo_flags` | `[]` | Labels added to the derived solo-only list |
| `work_batch.sizes` | none | Every size label, batchable or not, so the gap report can tell "no size" from "too large" |
| `work_batch.ranking` | the weights in [ranking](#ranking) | Score for each size, for the follow-up label and for each shared area label |

The rest comes from fields other skills read too: the batchable sizes
(`issue_tracker.labels.batch_sizes`), the repository label a batch item must
carry (`review.repo_label`, one of `review.taxonomy.repos`), the type labels
and context-label prefixes (`review.taxonomy`), the follow-up label, the
line budget, and the catalog path. The audit skill's configuration check
refuses `size_points` that do not price exactly the batchable sizes.

## After the merge

Every issue the batch closes needs the steps a single issue gets after its
pull request merges: the closing comment, label reconciliation, and moving
its epic forward (`do-item`'s `reconcile_parent_status.ts`). The batch's own
`Closes` table is the list: the skill runs the post-merge steps for each row,
not once for the pull request.

## Evidence

The skill ends each batch by recording its close-to-open ratio: issues it
closed, against new follow-up issues its review rounds filed. That ratio is
the only evidence that batching closes small issues faster than review
creates them, rather than just feeling faster.

## The eligibility mode

A tool that judges many issues at once, such as a dashboard panel ranking
possible batches across the whole backlog, runs the proposal script's
eligibility mode instead of keeping a copy of the rules: it hands over issues
in the tracker interface's form and gets back, for each, the verdict and
reason the proposal would give, with the effective policy (the solo-only
flags, the batchable sizes, the points). The plugin is installed per machine,
not as a package a repository can import, so this versioned JSON document is
the contract; its format is in [SKILL.md](SKILL.md#the-eligibility-mode).

## Left out

- **Ranking batches across the whole backlog** (a dashboard panel). It needs
  a dashboard and a backlog snapshot that Jig does not have; a repository
  that has both builds the panel on the eligibility mode.
- **Batches across repositories.** A pull request lands in one repository,
  so a batch does too.
- **Changing the review-finding scope rule for batches.** A batch with a
  `medium` issue usually passes the line count at which a review finding
  that widens scope is deferred rather than fixed in place. Whether that
  rule should change for batches is a separate decision, made from the
  close-to-open ratios.
