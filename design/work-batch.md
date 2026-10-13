# Batching small issues into one pull request: design

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
five closures cost about what one costs today.

This is the design of [ROADMAP.md](../ROADMAP.md) item 13: a `work-batch`
skill in the `jig` plugin, moved from a working repository that uses it
today. The first two steps of the [build order](#build-order) are built: the
tracker reads in the [tracker interface](../GLOSSARY.md) and the
tracker-neutral key in the [change-area catalog](../GLOSSARY.md). When the
item is finished, this design leaves the folder
([design/README.md](README.md)).

Contents: [the procedure](#the-procedure) ·
[what moves and what stays](#what-moves-and-what-stays) ·
[anchors](#anchors) · [solo-only issues](#solo-only-issues) ·
[batch size](#batch-size) · [ranking](#ranking) · [tracker reads](#tracker-reads) ·
[configuration](#configuration) · [after the merge](#after-the-merge) ·
[evidence](#evidence) · [build order](#build-order) · [left out](#left-out)

## The procedure

1. **Propose.** A script takes an *anchor* (an area of the code, a path, an
   epic or one issue; see [anchors](#anchors)), reads the open issues that
   match it, holds back every issue that may not join a batch, ranks the
   rest and fills a batch up to a [size budget](#batch-size). It prints the
   proposed batch, the issues it held back with the reason for each, and
   the matching issues that carry no size label at all (a labelling gap,
   which would otherwise make an area look empty).
2. **Check.** The agent reads each proposed issue in full (description and
   comments) and confirms what the script cannot: the issues are
   independent of each other, none is larger than its size label says, none
   is urgent, and each `medium` issue gets an explicit decision: re-size it,
   keep it, or leave it for its own pull request.
3. **Claim.** Just before claiming, the agent reads each issue again and
   drops any whose state, assignee, size, type, flags or priority changed
   since the proposal; a changed priority means step 2's urgency check no
   longer holds. It compares ids, not names: a state or a person can be renamed,
   and two can share a name. It then moves each issue to `in_progress`,
   assigns itself and comments on each one, naming the other issues in the
   batch. It records each issue's state and assignee ids as they were before
   the claim, for a release in step 4. It writes the batch form of the intent chain, which `do-item`'s
   `intent-chain.ts` already supports (`"mode":"batch"`).
4. **Implement.** One commit for each issue, each one validated before it is
   committed. Bug issues get the same sibling scout `do-item` runs for a
   single bug. After implementing, the agent checks the size again and, if
   the batch has grown past the budget, trims it in this order:
   1. **Take out** the lowest-ranked issues and their commits.
   2. **Release** each issue taken out. The agent reads it again first: if
      its state and assignee are still the ones the claim set, it goes back
      to the state and assignee recorded at the claim; if someone else
      changed either since the claim, the agent leaves that change in place
      and names the issue in its report for a person to settle. Either way
      the issue gets a comment saying it left the batch and why.
   3. **Stop if nothing remains.** With no issue left, the agent undoes
      everything step 3 wrote, not only the tracker changes: the issues are
      already released by substep 2, and the session's intent-chain copy
      (`.context/refocus-state/<session>.intent-chain.md`) is removed and
      the pickup token dropped, so Refocus stops putting released issues in
      front of the agent. `intent-chain.ts` has no operation for that
      removal yet; the skill adds one ([build order](#build-order) step 4).
      It writes no replacement chain, since a batch chain with no issues is
      not a valid one. It then opens no pull request, discards the branch's
      commits, and reports the released issues.
   4. **Re-anchor.** The chain's `issue` (the batch's anchor) is rendered on
      its own, apart from `items`, so taking the anchor out of `items` is not
      enough: when the anchor was released, the highest-ranked remaining
      issue becomes the anchor.
   5. **Rewrite the intent chain** for the remaining issues. The new pickup
      token is the one the pull request is captured with, so the drive is
      never pointed at a released issue.
   6. **Comment** on every issue still in the batch, naming the batch as it
      now stands, so no batch comment names an issue the pull request will
      not close.
5. **Open one pull request** through `do-item`'s `pr-plan.ts`. Its body
   carries a table with one row for each issue: `Closes <key>`, the issue's
   commits, and what changed. The per-issue `Closes` line is what closes
   each issue on merge.
6. **Drive it once** with `/jig:drive-pr`: one drive covers every issue.

## What moves and what stays

What moves to Jig is the mechanism: steps 1 to 6, the rules for which
issues may not join a batch, the size budget, ranking, the claim re-check,
the commit and pull-request conventions, and the tests that pin them.

What stays in the working repository is its values and its product-bound
code:

- its label names, which become [configuration](#configuration);
- its base branch and its drive launch line, which `pr-plan.ts` and
  `drive-pr` already derive or read;
- a dashboard panel that ranks possible batches across the whole backlog.
  It calls the same eligibility rules the skill uses. Once the skill is in
  Jig, the panel runs the skill's script with `--format json` instead of
  importing its code: the plugin is installed per machine, not as a package
  a repository can import.

## Anchors

| Anchor | Pool |
|--------|------|
| Change-area name | Open issues carrying the area's `tracker.labels` and a batchable size label |
| Path in the repository | The same, for each area the path belongs to |
| Epic | The epic's open children |
| One issue | Open issues sharing its area label; the issue itself is kept first when it is eligible, and an ineligible one ends the proposal with a recommendation to work it alone |

The area and path anchors read the change-area catalog
(`drive.change_areas_catalog`): the same `tracker.labels` that label an issue
for an area define which issues belong to it, so there is one answer, not a
second hand-kept list. A path anchor needs only the areas whose `paths`
match the path directly, not the areas they imply: the plugin's catalog
reader already does that matching ([build order](#build-order) step 3). An
area whose own `tracker.flags` include a solo-only flag cannot be an anchor:
every change there carries the flag, so no batch is possible.

An area's labels can include shared ones, such as a broad domain label that
several areas carry. Only a label that names the area itself narrows the
pool; the others add to an issue's rank. Which labels name an area is
already configured: `do_item.agents.codearea_areas` maps a label to the area
it routes to. When an area has no such label, its shared labels would select
issues from unrelated areas, and the script refuses the anchor instead of
proposing a batch of unrelated issues.

## Solo-only issues

An issue with a [sensitivity flag](../GLOSSARY.md) never joins a batch. Each
such flag starts a review gate or a human step that applies to the whole
pull request: a database migration review, an interface-contract review, a
privacy review, a manual operation after merge, or a decision that is a
human's to make ([HITL](../GLOSSARY.md)). In a batch, that gate would run
over five unrelated changes, or all six issues would wait for the one human.

In the working repository this list is a constant with no override, on the
argument that a safety rule someone can switch off is a suggestion. In Jig
the label names are each repository's values, so the list is derived, and
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
with no size label, no type label or an unknown area label is held back
too, with a reason that says which label to add. The issue is not dropped
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

The working repository's numbers are the starting defaults. It also keeps a
note to measure, across the first batches that include a `medium`, the
final line count and how often an issue had to leave the batch, before
changing them.

## Ranking

The proposal fills the batch in rank order. An issue's score is the sum of:

- the weight of its size label, so that cheaper issues come first;
- the weight of each provenance label it carries (the follow-up label above);
- the weight of each shared area label it carries, so an issue that touches
  the anchor's wider domain ranks above one that only names the area.

Higher scores come first. Ties go to the tracker's priority (urgent first,
no priority last), then to the older issue, then to the issue key in text order,
so the input order never decides which issue fits the budget. The defaults are size
`{xs: 2, small: 1, medium: 0}`, `3` for a provenance label and `1` for a
shared area label; `work_batch.ranking` replaces any of them. The skill's
tests pin these defaults, so a repository that sets nothing gets the same
order on every machine.

## Tracker reads

**Built.** The proposal needs reads the tracker interface did not have: open
issues filtered by several label conditions, the open children of an issue,
and one issue in the same form. Each result carries what eligibility and
ranking read: priority, creation time, the state and the assignee with their
ids, every label, whether the issue has open children, and which nested
lists were truncated. These are `openIssues`, `openChildren` and
`poolIssue` on the interface
([port.ts](../plugin/skills/do-item/scripts/lib/tracker/port.ts)), with the
Linear adapter's implementation and tests.

They differ from the working repository's reads as follows, each on the
side of the interface's rule that a short read is never presented as
complete:

- A pool is read to the end, or the read fails. The working repository
  stops after ten pages and warns; a team's open, labelled, small issues do
  not reach that size, so there is no partial result to manage.
- A pool is scoped to the configured team (`issue_tracker.team`); the
  working repository relied on its repository label alone.

An empty label condition is refused: it would widen the pool to every open
issue.

Adding these operations to the interface touches the open decision on
whether an adapter may leave reporting operations out
([ROADMAP.md § Open decisions](../ROADMAP.md#open-decisions)). They are not
reporting: a tracker that can list issues by label can answer them,
and a plan file kept in the repository can too.

## Configuration

A new `work_batch` section, documented in
[CONFIGURATION.md](../plugin/CONFIGURATION.md) when the skill lands:

| Field | Default | What it does |
|-------|---------|--------------|
| `work_batch.point_budget` | `16` | The main limit |
| `work_batch.size_points` | `{xs: 1, small: 2, medium: 6}` | Points each batchable size costs; its keys must be exactly `issue_tracker.labels.batch_sizes` |
| `work_batch.max_items` | `6` | The item limit |
| `work_batch.solo_flags` | `[]` | Labels added to the derived solo-only list |
| `work_batch.sizes` | none | Every size label, batchable or not, so the gap report can tell "no size" from "too large" |
| `work_batch.ranking` | the weights in [ranking](#ranking) | Score for each size, for provenance labels and for each shared area label |

The rest comes from fields that exist today: the batchable sizes
(`issue_tracker.labels.batch_sizes`), the repository label a pool must carry
(`review.repo_label`, one of `review.taxonomy.repos`), the follow-up label,
the line budget, and the catalog path.

The audit skill's `config-schema.yaml` lists each field and its readers in
the same pull request, and `config-fit.ts` checks that `size_points` covers
`batch_sizes` exactly.

## After the merge

Every issue the batch closes needs the steps a single issue gets after its
pull request merges: the closing comment, label reconciliation, and moving
its epic forward (`do-item`'s `reconcile_parent_status.ts`). The working
repository runs these through a separate post-merge skill that reads only
one issue from a pull request, and applies them by hand for the others. In
Jig, the batch's own `Closes` table is the list: the skill runs the
post-merge steps for each row, not once for the pull request.

## Evidence

The skill ends each batch by recording its close-to-open ratio: issues it
closed, against new issues its review rounds filed. That ratio is the only
evidence that batching closes small issues faster than review creates them,
rather than just feeling faster. Before the move, the working repository's
recorded ratios are read. If they do not show batching ahead, that is
reported before Jig takes the skill.

## Build order

1. **Tracker reads** (built): `openIssues`, `openChildren`, `poolIssue`.
2. **Tracker-neutral catalog key** (built): the change-area catalog's
   tracker block is `tracker:`. `drive-pr`'s fleet-health sensor still reads
   the older `linear:` spelling, so a repository can rename its catalog when
   convenient.
3. **A shared catalog reader.** `drive-pr`'s fleet-health sensor already
   reads the consumer repository's catalog (`drive.change_areas_catalog`),
   with code that ships in the plugin, and matches paths to areas
   (`parseCatalog`, `globToRegExp` in `fleet-health-sources.ts`). It moves
   to a library both skills use and also reads `tracker.flags`. The full
   [M3](../modules/M3-change-area-catalog/README.md) resolver, with its
   implied-by closure, is not needed for batching and stays a "Later" item.
   Jig's own `scripts/change-areas.ts` checks Jig's catalog for Jig's CI and
   stays where it is.
4. **The skill.** `candidates.ts` and its tests move, rewritten against the
   tracker interface and the configuration above. `SKILL.md` and
   `batch-policy.md` move with their origin references, review history and
   the working repository's names taken out. `do-item`'s `intent-chain.ts`
   gains the operation that removes a session's chain copy, which the
   empty-batch stop needs. The working repository's copy
   is deleted in the same rollout, and its dashboard panel switches to the
   script's JSON output.
5. **`do-item`'s batch check** names `/jig:work-batch` instead of "a
   batching skill, if the consumer has one".

## Left out

- **Ranking batches across the whole backlog** (the dashboard panel). It
  needs a dashboard and a backlog snapshot that Jig does not have; it stays
  in the working repository until a second repository asks for it.
- **Batches across repositories.** A pull request lands in one repository,
  so a batch does too.
- **Changing the review-finding scope rule for batches.** A batch with a
  `medium` issue usually passes the line count at which a review finding
  that widens scope is deferred rather than fixed in place. Whether that
  rule should change for batches is a separate decision, made from the
  close-to-open ratios.
