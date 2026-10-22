# Batch policy: the constraints, and what each protects

Every constraint below has a default, a way to change it, and a reason. The
reasons are the part worth reading: a constraint whose reason is lost gets
tuned away the first time it is inconvenient. Every field named here is in
the plugin's [configuration reference](../../../CONFIGURATION.md#work_batch).

## Solo-only flags: the one constraint no setting loosens

An issue carrying a solo-only flag never joins a batch. The list is derived
from the repository's own configuration, and configuration can only add to
it:

- the human-in-the-loop label (`issue_tracker.labels.hitl`) and every facet
  of it (`<hitl>:<stakeholder>`);
- the manual-operations label (`issue_tracker.labels.manual_ops`);
- every label any area of the change-area catalog names in its
  `tracker.flags`, since a catalog flag exists to start a gate;
- `work_batch.solo_flags`, for flags the catalog does not project (a privacy
  label applied by hand, for example).

No setting removes a label the first three sources supply: a safety rule a
setting can switch off is a suggestion. The skill's tests pin that.

What batching each kind would do:

| Flag | What batching it would do |
|------|---------------------------|
| A database-migration flag | Runs the migration review over every unrelated change in the batch, and puts the least reversible change in the repository beside five others |
| An interface-contract flag | Runs the contract review over the whole batch, and ties a change that regenerates clients to issues that must not wait for it |
| A privacy or legal flag | Sends the batch to counsel for one issue's sake |
| The manual-operations label | Leaves the merged batch waiting for a person's step, parked rather than closed, for one issue |
| The human-in-the-loop label | The issue's deliverable is a person's judgment; a batch is driven unattended, so the agent would pre-empt the person or every issue would wait |

**Provenance labels are not flags.** An issue filed from a review finding
(`issue_tracker.labels.followup`) records where it came from and starts no
gate. It is already-owed, already-scoped work, the densest source of
batchable issues, and it ranks *higher*.

**Anchor refusal.** An area whose own `tracker.flags` include a solo-only
flag cannot be an anchor: every change there carries the flag, so no batch
is possible there. The same holds for an issue: one whose area-naming label
names such an area is held back as solo-only even when the flag itself is
missing from its labels, whether it is the anchor issue, an epic's child or
an issue the eligibility mode judges.

## Fail-closed reads

Every read that cannot be completed holds the issue back rather than
admitting it:

- **Truncated labels.** An issue whose label list came back incomplete is
  held back before any other check: a solo-only flag could be on the part
  not read.
- **No size, no type, no repository or context label, or only context or
  area labels the configuration does not know.** The issue carries no
  reliable classification, so it is held back with a reason naming the label
  to add. A context label (one starting with a
  `review.taxonomy.context_prefixes` prefix) is known when the configuration
  already names it: a key of `do_item.agents.codearea_areas` or
  `do_item.agents.labels`, or a catalog area's `labels` or `tracker.labels`.
  One known label beside an unknown one is enough; the typo is someone
  else's cleanup.
- **Sizes the repository does not list.** The known sizes always include
  `review.taxonomy.sizes`. With `work_batch.sizes`, every size label is
  known: two of them are a conflict, and one that is not
  batchable is too large. Without it, the known sizes are the batchable sizes
  and `review.taxonomy.sizes`; a size label named in neither (a `large` the
  repository never lists) is not recognised, so an issue carrying `small`
  and such a label is read as `small`. Set `work_batch.sizes` to close that
  gap; the audit's configuration check warns when a `work_batch` section
  leaves it out.
- **Two labels of a pick-one group** (two sizes, two types, two
  repositories) are a labelling error, not a choice to make by order: two
  sizes could batch an issue its own labels also call too large, and two
  repositories would close an issue whose other half lives elsewhere.
- **A pool is read to the end, or the read fails.** The tracker interface
  never presents a short read as complete, so there is no partial pool to
  rank.
- **The labelling-gap read is diagnostic.** When it fails, the proposal
  still stands and a warning says the gaps went unreported: a drained-looking
  area may still hold issues with no size.

A check the repository does not configure is off and says so in the
eligibility mode's policy: without `review.repo_label` no repository label is
required, without `review.taxonomy.types` no type label, without
`review.taxonomy.context_prefixes` no context label.

## Batch size

A batch has two limits, applied in one pass down the ranked list: take each
issue that still fits both, and skip (not stop at) one that does not, so an
expensive issue that no longer fits leaves room for cheaper ones below it.

**Points, the main limit** (`work_batch.point_budget`, default 16; `--budget`
for one run). Each batchable size costs points (`work_batch.size_points`):

| Size | Points |
|------|--------|
| `xs` | 1 |
| `small` | 2 |
| `medium` | 6 |

What a batch spends is review attention and changed lines, and a size label
is a better proxy for those than a count of issues. At these numbers at most
two `medium` issues fit (2 × 6 + 2 × 2 = 16; three cost 18), and a batch of
only `xs` and `small` issues reaches the item limit first (six `small` cost
12). `size_points` must price exactly the batchable sizes
(`issue_tracker.labels.batch_sizes`); the audit's configuration check and the
skill both refuse anything else.

**Items, the second limit** (`work_batch.max_items`, default 6; `--limit` for
one run). Points do not bound how many separate concerns one review round
must hold, each with its own threads; this does.

**An issue anchor's own seed** is always kept, charged against both limits.
When it alone costs more than the budget (only with a lowered budget), it is
still proposed and the run warns.

**Changed lines** are checked after implementing, since the diff does not
exist when the batch is proposed: `pull_requests.size_budget`, which
the `open` operation of `do-item`'s `pr-plan.ts` measures. Over it, the batch is trimmed,
lowest-ranked issue first.

**Measure before retuning.** Across the first batches that include a
`medium`, record the final changed-line count and how often an issue had to
leave the batch. That decides whether a `medium`'s price or the budget
changes.

## The verdict on the largest size

A `medium` label is the least reliable in both directions: a `small` often
turns out to be several pull requests' work, and an issue sized `medium`
while it waited on a decision often dissolves in one pass. So every issue of
the most expensive batchable size gets an explicit verdict before it stays:
re-size it, keep it, or leave it for its own pull request. The point budget
bounds what one costs; the verdict keeps it from riding in on its label alone.
The solo-only flags still apply, so the riskiest `medium` changes still go
one per pull request.

## Ranking

The proposal fills the batch in rank order. An issue's score is the sum of:

| Part | Default weight | Why |
|------|----------------|-----|
| Its size | `xs` 2, `small` 1, `medium` 0 | Cheaper closures first |
| The follow-up label | 3 | Already-owed work, already scoped |
| Each shared area label of the anchor | 1 | Shared context is what lets one review pass cover it |

`work_batch.ranking` replaces any weight (`sizes`, `provenance`,
`shared_area_label`). Ties go to the tracker's priority (urgent first, no
priority last), then the older issue, then the issue key in text order, so
the input order never decides which issue fits the budget. Priority breaks
ties without adding to the score: an urgent issue is not batched at all.

## Area coherence

**One area is preferred, not enforced.** An epic anchor may legitimately span
two. A mixed batch takes the union of both areas' validation and mandatory
reviews; two coherent pull requests usually cost less than one incoherent
one.

**Only a label that names the area narrows the pool.** An area's tracker
labels can include shared ones, such as a broad domain label several areas
carry; those only add rank. The labels that name an area are the ones
`do_item.agents.codearea_areas` routes to it. An area without one is refused
as an anchor: its shared labels alone would select issues from unrelated
areas.

**A path anchor** belongs to the areas whose own `paths` match it directly,
not the areas they imply. A directory also belongs to every area with a
glob that could match a path below it, however deep, so a narrower area that
holds only part of its subtree, and that area's flags, are found. A glob that
cannot be read segment by segment (braces spanning a `/`) is counted in.

## State and ownership

- **A state is read by its category**, and when the tracker reports none it
  is known by (an empty category included), by its name through
  `issue_tracker.states`. A state neither names is held back, never read as
  backlog work.
- **Started or assigned issues** are held back: someone is working them, or
  will. `--claimed KEY,KEY` admits named issues only, for your own earlier
  claim on this batch; it never admits every started issue in the pool.
- **Epics and issues with open children** are containers, not work a batch
  closes.
- **One repository per batch** (`review.repo_label`), since a pull request
  lands in one.
