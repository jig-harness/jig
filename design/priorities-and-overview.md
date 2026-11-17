# Declared priorities, a progress review and the overview: design

**What problem this solves.** A person can see individual failures without
seeing whether their goals are advancing. The priority of an
[epic](../GLOSSARY.md), the issue that groups the issues of one goal, does
not reach its children, and written priorities disagree with the tracker's
fields.
With this built, a declared purpose and a reproducible ranking explain the
shortlist, a scheduled review spots lack of progress across work, and one
overview shows the goals, activity and decisions together.

This is the design of [plan.md](plan.md) item 58, accepted by the person on
2026-11-17. None of it is built; its build steps are issues under epic
#1177, in the order [Build order](#build-order) gives, and the overview's
visual design round (#1182) comes before its user interface. It extends [M9's computed prioritization
invariant](../modules/M9-tasks-memory/README.md#computed-prioritization),
not its scored criteria. The review pass is named **progress review**
([glossary](../GLOSSARY.md)). It becomes part of M9 after a host opt-in
trial on Jig and one [consumer repository](../GLOSSARY.md) (a repository
that uses Jig) proves it; no new practice module or audit score is
introduced now. It is part of M9 rather than a module of its own because it
reviews progress against the same record M9's computed prioritization
reads: declaring priorities, ranking from them and checking progress
against them are one practice, and two modules would share one record.

## How it works

### One priorities record, each level whole

A **priorities record** ([glossary](../GLOSSARY.md)) states objectives in
one versioned format, `priorities/v1`. Its envelope has `level` (`site`,
`repository`, `individual`), `scope`, `revision` and `objectives`. Each
objective has a stable `id`, `class` (`core`, `tactical`, `peripheral`),
`purpose`, a verifiable `endState`, `owner`, exactly one of `epics` (tracker
scope plus keys or label selectors) or `refs` (a list of objective
references, each a `level`, `scope` and `id` naming an objective at another
level), and an optional `share`.
A reference resolves against the latest valid revision of that level's
record read for the same input snapshot, and the ranking pins the revision
it used. A reference that names no objective, a cycle of references, or a
record that cannot be read is incomplete input.

An objective's class names its [priority lane](#lanes-and-their-weights),
and its `share` is a rational fraction of that lane's starts at its level.
An objective with no `share` receives an equal part of its lane's residual
share after the explicit shares at that level. With no such objective the
residual is unreserved; it lends starts to the lane's ready objectives in
record order without changing their declared shares. With zero residual, an
objective with no `share` has no entitlement but remains in the shortlist
for a person to choose. These are schema-defined rules, not silent
normalization. No objective declares a number of slots: how many sessions
run at once is the host's capacity at that moment, and a share divides the
starts that capacity allows. `owner` is a role at site and repository
levels; only the host's individual record names a person. The schema
rejects unknown fields, duplicate ids, empty selectors, negative values,
shares above one, and a share total above one within one lane at a level.

The repository record is read by the owner host's
[dispatcher](../GLOSSARY.md), the scheduled command that starts unattended
sessions. The site record is read by the [hub](../GLOSSARY.md), the optional
service several dispatchers' hosts report to
([control plane design](control-plane.md),
[ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)),
and is built when the hub is.

| Level | Proposed home and reader | Independence |
| --- | --- | --- |
| Repository | `.config/priorities.yaml`, read from the default branch by the owner host's dispatcher | Works with no site or individual record |
| Individual | `priorities` under that person's entry in the host dispatch file | Restricts the work that host serves for the person; never published in a repository |
| Site | The hub's configured priorities file, managed by its operator | Built with the hub, never required by a host; shared tracker scopes are groupings within this level |

Coincident levels need one declaration: an absent level adds no restriction
and does not require a copied record. A site objective references repository
objective ids or directly selects scoped tracker epics and labels; an
individual objective references those ids or its own tracker selectors.
A standalone site needs no repository record: its direct selectors supply
membership and its own shares supply ranking. Referenced objective ids must
resolve; an absent referenced record is incomplete input, never a silent
replacement by a direct selector. A narrower level may restrict which work
it serves; it never widens what a broader level excludes. Each level has
its own allocation counters: a proposed start is charged once at each
applicable level. The lowest applicable objective share is its effective
entitlement; unused share remains unreserved rather than being
redistributed into the record. An infeasible record (a lane's shares above
one, an unresolved reference) is reported and blocks use of that revision
for allocation; the last valid revision remains visible with its age. No
reader silently renormalizes a person's choices. A host never transmits its
individual declarations or identities to a site; the site receives
aggregate capacity and objective progress only.

The `priorities` skill prepares a change through a pull request for a
repository record, validates it, and shows the resulting shortlist diff.
For a host record or the host's weights file it prepares a local diff for
its owner, never a pull request containing personal identities. Site
changes use the hub's operator configuration procedure. The skill never
launches work or changes tracker Priority fields. Initial records are
authored from the person's stated goals, not inferred from the order of a
plan page. The plan remains the explanation; the committed record supplies
the shares a rule reads.

### Lanes and their weights

A **priority lane** ([glossary](../GLOSSARY.md)), a lane for short in this
document, is one kind of work that competes for starts. Every item the
ranker sees falls in at most one lane:

| Lane | What it holds | Place | Default weight |
| --- | --- | --- | --- |
| `urgent` | Every eligible Urgent issue, bug or not, inside or outside objectives | First, always tracked | none: ahead of every lane |
| `bug-high` | Assigned bugs of High priority | Next, ahead of objective work | none: ahead of the weighted lanes |
| `bug-other` | Assigned bugs of Medium or Low priority, then those with no priority | Shares starts by weight | 15 |
| `core` | Work whose allocation owner is a `core` objective | Shares starts by weight | 50 |
| `tactical` | Work whose allocation owner is a `tactical` objective | Shares starts by weight | 25 |
| `peripheral` | Work whose allocation owner is a `peripheral` objective | Shares starts by weight; its weight is a floor | 10 |

A bug sits in its bug lane whatever objective it also belongs to; the
objective shows it for reporting only. Work in no lane (outside every
objective and not a bug) stays visible as
unallocated work after the lanes, and a person may still choose it.

`bug-other`, `core`, `tactical` and `peripheral` are the **weighted lanes**. Each takes a weight from 0 to 100,
and a weighted lane's share of the weighted starts is its weight divided by
the sum of the weights of the weighted lanes in rotation. `bug-other`
competes with the objective lanes by weight and never jumps ahead of them:
on a tie, an objective lane wins. A bug with no priority sits in
`bug-other` after the bugs whose priority is known, and the report shows the
missing priority as a gap. `urgent` and `bug-high` take no share: they come
first and next, and their weight only says whether they are in rotation.

A weight of 0 takes any lane out of rotation: none of its work is proposed
for a start. Urgent issues stay listed in every shortlist and report even
then, since visibility never depends on eligibility. The `peripheral`
lane's weight is also its minimum, the **peripheral floor**: unlike the
other lanes, a share it could not use while it had no ready work is owed
to it later in the week and carried for one week, as the ranking below
says.

Weights divide starts, never slots. How many sessions the host can start at
a moment changes with its load and with each account's remaining quota (an
account at its limit contributes nothing until its reset), and the weights
divide whatever starts that capacity allows. The shares are fair over time,
with the peripheral lane's one-week carried debt, not slots held back for a
lane. An account's `max_per_account` stays a safety ceiling on one account's
concurrent sessions, not the means of allocation.

The weights live in the host's **weights file**
([glossary](../GLOSSARY.md)), `$JIG_HOME/weights.local.yaml`
(`~/.jig/weights.local.yaml` by default), beside the machine file. It is
the host's own and never committed: where `$JIG_HOME` sits inside a
repository, that repository ignores it. The dispatcher reads it again on
every tick, so a change takes effect on the next tick with no pull request,
restart or reinstall. It has two sections: `lanes`, read by the ranking,
and `accounts`, each account's weight for its share of new launches (issue
#1402):

```yaml
lanes:
  bug-other: 15
  core: 50
  tactical: 25
  peripheral: 10
accounts:
  work: 100
  spare: 25
  reserve: 0
```

A missing file or a missing entry means the built-in default. An unreadable
or invalid file, a weight outside 0 to 100 or an unknown lane name is
reported in the tick report and fails closed for what it cannot read: an
invalid entry for a recognized lane takes that lane out of rotation, while an
unknown lane name or a file that cannot be parsed takes every configurable
lane out. A broken file therefore never resumes a lane the person paused. The
shortlist still lists every Urgent issue. The weights read for a start are
recorded with its charge, so a changed weight never rewrites past starts.

### Computed ranking proposes a shortlist

The mechanical ranker takes an immutable tracker snapshot, the effective
priorities revisions, the lane weights read this tick, a capacity snapshot,
and an explicit `asOf` timestamp.
Its output records all input hashes, the algorithm version and the explanation
for each position. It makes no model call. The tracker interface normalizes
GitHub, Linear and Jira priorities, parents, blockers and states; a missing
facet stays unknown and appears as a gap, never as low priority.

Membership is derived from the declared epic keys or labels and their live
children. At each applicable level an item's **allocation owner** is the
first matching objective in that record's explicit order. Only that owner
may include the item in its [ready pool](../GLOSSARY.md) (the tracker
states ready work waits in), consume its share, or count its start toward
the peripheral floor. Other objective memberships
are reporting relations only. Ownership is derived before ranking and pinned
to the input revision of each claim (the marker a pickup writes when it
takes an item, [glossary](../GLOSSARY.md)); an overlapping core-owned item cannot be
selected through a peripheral objective or repay its floor. Owners at
different levels must name the same lane class; otherwise the item is an
allocation conflict and is excluded. Cycles, ambiguous
tracker scopes and unreadable
parentage are reported as incomplete evidence and excluded from allocation.
An epic's effective rank reaches its children: a child's own ordinary Priority
orders siblings and does not erase the epic's entitlement.

The shortlist is computed in this order:

1. Apply existing start guards, holds (a person's mark that keeps the line
   off an item), blocker rules, claims and the host's individual
   restrictions. Keep excluded work in the report with its reason. Never
   loosen a guard to fill a start.
2. Place the `urgent` lane first, across every objective and outside
   objectives, then the `bug-high` lane. A bug that is Urgent occupies only
   its Urgent position. Stable ties use tracker scope then canonical key.
   These starts count toward no weighted lane and no objective's share; they
   take the host's capacity like any start.
3. Allocate the remaining prospective starts to the weighted lanes, then
   within a lane to its objectives, by weighted fair allocation:
   - For the next start let `N` be the weighted-lane starts already charged
     in the current UTC week plus tentative starts in this computation. For
     ordinary fair allocation, let `N[l]` and `n[l]` count only the weighted
     starts since lane `l` last had no ready work: `N[l]` is every such
     opportunity and `n[l]` is the starts assigned to `l`. The tracker-snapshot
     tick records each empty-pool transition and its epoch with the snapshot
     hash; the pure ranker reads those persisted epochs, including their
     revision in its input hash, so they remain ranking inputs after a restart. A lane that
     becomes ready therefore starts with no catch-up entitlement. A lane's
     share `share[l]` is its weight over the sum of the weights in rotation;
     `fNext` is the `peripheral` lane's share for the prospective start.
   - Let `D0` be the immutable debt at this week's opening, `E` the sum of
     the recorded peripheral shares for this week's earlier weighted charges
     (including tentative charges), and `P` all peripheral starts this week,
     tentative ones included. What the peripheral lane is owed for the next
     start is `owed = D0 + E + fNext - P`. A peripheral start repays the opening
     debt first, so outstanding debt is `max(0, D0 - P)` and credit toward
     this week's floor is `max(0, P - D0)`.
   - When `owed` is at least one whole start and peripheral is in rotation,
     restrict the choice to the ready pools of peripheral allocation owners. If
     no peripheral work is ready, or peripheral is out of rotation, lend the
     start and report the unmet floor. Below that threshold,
     peripheral remains an ordinary ready lane and may win fair allocation.
   - Otherwise choose the ready lane with the largest deficit
     `share[l] * (N[l] + 1) - n[l]`; ties go to `core`, `tactical`,
     `peripheral`, then `bug-other`.
   - Within `bug-other`, order by tracker Priority (Medium, then Low, then
     none), then tracker scope and canonical key. Within an objective lane,
     choose the ready objective with the largest deficit
     `share[o] * (n[l] + 1) - n[o]`, where `n[o]` counts the starts
     allocated to objective `o` in the same lane epoch as `n[l]`; tie by
     record order then id. At coincident
     levels charge once; at distinct levels each level chooses
     independently and the start goes to their intersection. If it is
     empty, report an allocation conflict rather than guessing which level
     wins. A lane's residual unreserved share is lent in record order when
     none of its objectives with a positive deficit is ready.
   - An entitlement is a proposal, never a launch, and never a slot held
     open.
4. Within an objective, order epics by their declared position, then their
   tracker Priority; order eligible children by Priority then canonical key.
   Emit the eligible unallocated work afterward in the same deterministic
   order. Work outside every lane remains visible as unallocated work,
   after declared work; the person may still choose it.

A start means a successful pickup claim, irrespective of eventual duration
or outcome; shares distribute starts, not processor time or hours. A
successful claim records one immutable charge keyed by claim id in the
registered `allocation_charge` table, written by the pickup claim path in
the same step as the claim: its lane, its allocation owner at each level
and the lane weights read for it. An unsuccessful claim records none, and
replays count a claim once. Urgent and `bug-high` starts are recorded with
their lane and excluded from `N` and the lane counters. The weekly counters
are derived from these charges; when the weights change during a week, the
floor term `f * N` is the sum of the peripheral share recorded with each of
the week's weighted charges, so changing weights does not rewrite
historical charges.

At a week boundary, the next week's opening debt is
`max(0, F - max(0, P - D0))`, where `F` is the completed week's floor
entitlement (the sum of each weighted charge's recorded peripheral share) and
so also its cap. The first tick of a week writes it once
into the registered `allocation_week` table, keyed by week, with the
completed week's `N`, `P`, `D0` and `F`; the row is never rewritten. The
charges are kept for at least two weeks so a tick that missed the boundary
can still write the row. With no row for the previous week and no charges
to derive it from, the week opens with no debt, and the report says so.
The opening `D0` never decreases during the week; repayment is derived from
`P`, so a peripheral start cannot both repay debt and count in full toward
the new floor. For example, with opening debt 1 and two peripheral starts,
one repays debt and one earns current-week floor credit. At each boundary
replace, never add to, the opening debt with the completed week's unmet
entitlement; old unpaid debt is discarded, so absence cannot accumulate an
unbounded claim over later work.
These values belong to the ranking input, not hidden process state.

#### A sample week

The default weights (`bug-other` 15, `core` 50, `tactical` 25, `peripheral`
10) give `f = 0.1`. The previous week had 16 weighted starts and one
peripheral start with no opening debt, so this week opens with
`D0 = max(0, 1.6 - 1) = 0.6`. Peripheral work is blocked until the ninth
launch. "N" and "P" are counted before the launch; the deficit is the
chosen lane's.

| Launch | Kind | N | P | Owed | Lane | Why |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | weighted | 0 | 0 | 0.7 | `core` | largest deficit, 0.5 |
| 2 | weighted | 1 | 0 | 0.8 | `tactical` | largest deficit, 0.5 |
| 3 | Urgent issue | – | – | – | `urgent` | first; not counted in N |
| 4 | weighted | 2 | 0 | 0.9 | `core` | largest deficit, 0.5 |
| 5 | weighted | 3 | 0 | 1.0 | `bug-other` | floor owed, no peripheral work ready: lent; largest deficit, 0.6 |
| 6 | weighted | 4 | 0 | 1.1 | `core` | floor owed and lent; largest deficit, 0.5 |
| 7 | weighted | 5 | 0 | 1.2 | `tactical` | floor owed and lent; largest deficit, 0.5 |
| 8 | High bug | – | – | – | `bug-high` | ahead of the weighted lanes; not counted in N |
| 9 | weighted | 6 | 0 | 1.3 | `peripheral` | owed a whole start, peripheral work ready |
| 10 | weighted | 7 | 1 | 0.4 | `core` | largest deficit, 1.0 |
| 11 | weighted | 8 | 1 | 0.5 | `core` | largest deficit, 0.5 |
| 12 | weighted | 9 | 1 | 0.6 | `tactical` | largest deficit, 0.5 |
| 13 | weighted | 10 | 1 | 0.7 | `bug-other` | largest deficit, 0.65 |
| 14 | weighted | 11 | 1 | 0.8 | `core` | largest deficit, 1.0 |
| 15 | weighted | 12 | 1 | 0.9 | `core` | largest deficit, 0.5 |
| 16 | weighted | 13 | 1 | 1.0 | `peripheral` | owed a whole start |

The week ends with 14 weighted starts: `core` 7, `tactical` 3, `peripheral`
2 and `bug-other` 2. Its floor entitlement is `F = 0.1 * 14 = 1.4`; the two
peripheral starts repaid the opening 0.6 and earned 1.4 of credit, so the
next week opens with `max(0, 1.4 - max(0, 2 - 0.6)) = 0` debt. Had
peripheral work stayed blocked all week, the next week would open owing
`F = 1.4`, and the 0.6 carried in would be dropped.

The ranker reports a disagreement when an epic's inherited position and the
tracker Priority imply different ordering of comparable ready work. It names
both references, the field values and the rule, and never edits either.
Urgent issues are listed even when blocked, unassigned or outside all goals;
visibility does not grant eligibility. A person picks from the shortlist.
Existing dispatch selection remains within the person's assigned or explicitly
admitted ready pool; this design grants no power to pick a different item.
The proposed planner and a progress review consume this output; neither
silently retunes its weights.

### Progress review: proposals after mechanical facts

The progress review first reads a mechanical digest: the facts a script
gathers before the pass reads them. Like the [steward](../GLOSSARY.md) (the
agent pass that proposes recoveries for stopped work), within the frame
[ADR-0018](../docs/adr/ADR-0018-the-steward-proposes-within-a-remit-the-host-widens.md)
sets, it proposes; the [tick](../GLOSSARY.md) (one run of the dispatcher)
or the person acts. It never picks, starts, answers, re-ranks, files,
changes a priority, or changes configuration. The steward keeps individual
stopped items. Its open fixes land before this pass is enabled, and each of
them gates build step 3: first its digest and reliability fixes, #953 (the facts
its digest lacks, and passes that end without submitting), #924 (start on a
judgment backlog, not on any change) and #925 (why its resume and re-arm
proposals are not applied); then its remit fixes, #954 (a settle record for
a stalled item or a stale claim), #955 (one more re-drive after a
classified flaky check) and #956 (a re-run of failed checks).

The proposed `progress_review` host setting has `enabled` and `every`, the
keys the steward's setting has. Like the steward, the stage has a fixed
deadline and a fixed cap of starts in a rolling hour, not further settings.
The owner host schedules the stage; the `priorities` skill runs the same
review on demand, so the review needs no skill of its own. A hash of
priorities revisions, tracker snapshot, ranking output, the revisions of the
[line](../GLOSSARY.md)'s records (what the dispatcher and the sessions it
starts record) and the last row read from the [outcome log](../GLOSSARY.md)
(a row per ended launch and its cause) suppresses unchanged scheduled runs.
A time bucket in the hash advances when a configured no-movement threshold
is crossed, even if no item changed. Budget exhaustion leaves a due review
for the next admissible tick, with a reason, not a failed person decision.
An on-demand unchanged run is explicitly reported as reused unless requested
as a fresh review within the same budget.

The digest carries the last successful review and its input hashes, objective
membership, approved epic plan revision and child set, stage transitions,
claims, launches, outcomes, delivery failures, ready capacity and current
needs. Missing sources are named with last-read timestamps. Partial data
cannot support a finding that something did not happen. The review's closing
report records which inputs were complete, its proposals and its failure
class; timeout or no-result is handled by the existing stage recovery rule.
There is no new resident process.

Proposed registered tables are `progress_review_run`,
`progress_review_finding`, `file_draft`, `allocation_charge`, `allocation_week`
and `allocation_lane_epoch`, with the same owner, retention,
export and schema registration discipline as [the records registry](../plugin/RECORDS.md).
Findings have a stable fingerprint (kind, scope and targets), input revision,
observed interval, structured facts and evidence references. Repeated runs
update a finding rather than making a new decision each time. Resolved
findings retain the resolution event and leave the current overview.
Only these finding kinds are accepted:

| Kind | Facts it must carry | Consumer |
| --- | --- | --- |
| `progress` | Objective and epic, planned and current child sets, stage counts, completed work, canceled work separately, and no-movement interval for each class | Goals, epic progress, insights |
| `urgent` | Every Urgent issue, its current stage and last movement; no movement past the threshold is a finding | Urgent section and every report, including reused reports |
| `repeated-hold` | Hold class, distinct occurrences and interval, proposed systematic remedy and existing issue or draft | Recommended fixes |
| `idle-capacity` | Free capacity, ready references, lane weights and exclusion reasons | Activity and insights |
| `scope-growth` | Approved plan revision, added children, and work outside all objectives | Goals and insights |
| `decision-owed` | Existing decision id, owner role, age, blocked references and current options | Needs you (the dashboard's view of what waits on a person) and the chat digest (#1106) |
| `epics-in-flight` | Epics in progress, epics closed in the trailing 28 days, the threshold and the date read | Insights, as a recommendation to finish epics before opening more |

The tick validates the closed schema and re-reads target revisions before
accepting a proposal. It publishes facts only; it cannot turn a reason into
a command. A new fix needs a `file_draft` prepared through the filing skill's
taxonomy, priority, duplicate and scope checks, with their evidence and age.
The draft is a separate record referenced by `repeated-hold`; it is not an
issue and reserves no tracker key. A fix with an existing issue links it.
An `epics-in-flight` finding is a measure and a recommendation, never a
limit: nothing stops an epic from starting. By default the review
recommends fewer epics in progress when they exceed twice the epics closed
in the trailing 28 days, and never below 3; both numbers are part of the
host's review policy.
Decisions owed are ordered by Urgent work blocked, then declared objective
rank, then age and stable decision id. The review may explain that order,
but does not create an answer or change the mechanical ordering.

A report always includes all known Urgent issues, including none when the
snapshot proves that, or an explicit incomplete-reading mark. Progress is
measured by stage changes and completed acceptance, not comments or tokens
spent. The no-movement threshold is part of the host's review policy and
recorded with every finding; a planned wait is shown as waiting rather than
accused of being stalled. No heuristic finding becomes a new scored audit
criterion during the trial.

### One overview, structured facts

The overview is a view inside the existing
[dispatch dashboard](../GLOSSARY.md) (item 42),
then inside the hub (item 49), not a second dashboard or per-run report.
It works in an ordinary browser. A level switch selects repository, individual
or site. A standalone host offers its supported levels; site is absent until
the hub ships. Individual filtering is local to an authorized host view and
never expands the audience of the [source feed](../GLOSSARY.md), the
protocol through which one dashboard reads another machine's records.

Every issue or pull-request reference has `kind`, scoped `id`, `state`,
`url`, and `counterparts` (typed references by id, with an empty list when
known absent and `unknown` when unread). A fact relation has `subjects`,
`relation` (a closed verb such as `waits-on`, `implements`, `blocks`),
`objects`, `count`, `observedAt` and `sourceRevision`. Counts are derived from
those sets, with a separate total and pagination cursor for truncated sets.
Sentences are rendered from facts; the planner (the proposed skill that
writes an epic's execution plan) and progress review author
this contract. Free-text interpretation is detail, never the source of a
status, count, action target or relation.

| Section, in display order | Data it reads |
| --- | --- |
| Goals as stated | Effective priorities record and lane weights: purpose, end state, owner role, lane, share, the floor owed and rank explanation |
| Urgent, always tracked | Full normalized Urgent tracker set, start exclusions, claims and last stage event |
| Epic progress | Tracker child set, approved plan revision, acceptance and stage events; canceled children shown separately |
| Assigned bugs, by priority | Assigned normalized bug set with tracker Priority, lane (`urgent`, `bug-high` or `bug-other`), and claim and pull-request counterparts |
| Current activity | Launches, session presence, [drive ledger](../GLOSSARY.md) (the state a pull request's review loop keeps on it), holds, dependency edges and outcome log |
| Insights | Validated progress-review findings, the epics-in-flight measure and source ages |
| Follow-up debt | From the tracker snapshot, in weekly buckets over the trailing 8 weeks, each dated: the rate follow-up issues are minted, the share of each week's follow-ups closed, epics closed and follow-up age |
| Recommended systematic fixes | Repeated-hold findings and existing issues or checked File drafts |
| Decisions owed | Registry needs and decision-owed ordering; same ids as Needs you and the chat digest |

Each epic opens a table pairing issues with their pull requests, including
multiple or absent counterparts. Its stage totals distinguish implementation
before a pull request (PR), PRs being driven, PRs parked, waiting on other items and waiting
on the person. Stage membership is exclusive for totals; dependency relations
remain visible beside it. Precedence is done, ready to merge, parked on you,
waiting on other items, unknown, stalled, actively progressing. A mark
applies only when the evidence it rests on is complete and current. Ready
uses the existing [merge-ready predicate](dispatch-board.md#ready-exactly),
the rule the dispatch board uses to say a pull request may merge now.
Stalled requires a crossed no-movement deadline with complete observations.
Unknown applies when no earlier mark's evidence holds and the observations
stalled or progressing need are missing or stale, so absence never becomes
a successful or stalled status.

Every mark has an icon, colour and word: actively progressing, stalled,
parked on you, waiting on other items, ready to merge, done, and unknown,
whose word is “Unknown” and whose icon is a question mark in a neutral
colour. Issue and PR
references use distinct icons and labels, links and hover panels. Default
text is short; desktop hover exposes counts and detail, and a visible details
button exposes exactly the same information on touch and keyboard.
Recommended options have a subtle frame plus the word “Recommended”; a picked
option has a stronger state. `Clear pick` and a second tap on the picked
option both clear it. Selection alone sends nothing. These changes arrive
with the overview design round; existing Needs-you rows do not change now.

The follow-up debt view is a section of the overview, not a separate
report. Its measures are the ones `plugin/skills/drive-pr/scripts/fractal-metrics.ts`
already computes for a window (`mints_per_day`, `cohort_closure_share`),
read per week; a week whose source could not be read is shown as unread,
never as zero.

**Future, not planned.** Sliders for the lane weights and the picked epics'
weights, in the dispatch dashboard first and the hub's interface later. A
slider would change the host's weights file, which the next tick reads;
each change would be one browser act under
[ADR-0023](../docs/adr/ADR-0023-browser-actions-use-a-local-unlock.md),
with its confirmation and, on a phone, the unlock. The page has no write
route to a host, so how such an act reaches a host-local file is open.

### Actions: the person's browser makes one write

The action path extends the page's Send, which answers a parked decision
from the browser, and its decision record,
[ADR-0019](../docs/adr/ADR-0019-the-dashboard-page-answers-as-the-person.md).
These acts take the same path, and
[ADR-0023](../docs/adr/ADR-0023-browser-actions-use-a-local-unlock.md)
records what they keep from that record and what they amend. Each action is
either an existing write the line reads or a newly registered record with a
named reader, sent directly from the browser to the [forge](../GLOSSARY.md)
(the code host) or tracker as the person, with no request to a host. Before
sending, a confirmation shows target, action, selected option,
exact payload and expected effect. Refresh the target revision and permission
before confirming; a changed decision or head invalidates the confirmation.
A lost response is unknown, not failure: re-read for the request id before
retrying. Where the forge or tracker accepts a key that marks a repeated
request as the same one, so a resend does not write twice, the key is built
from the existing writer's identity.
Each call meets the [governed transport](../GLOSSARY.md)'s obligations
([ADR-0021](../docs/adr/ADR-0021-outbound-calls-are-governed.md)) as ADR-0023
applies them to a browser. The page reads the sending token's own forge and
tracker balance, fresh and per resource, and sends nothing below the share
the tick keeps (the host's published balance counts only for the same
login); it obeys a rate-limit refusal until its
reset and shows that time; it maps each answer to a failure class. A browser
cannot reserve budget in the host's record or write to its cost ledger, so
ADR-0023 records a scoped exception to ADR-0021 for those obligations and
for the page's own door to each system.

Acts become sendable in this order:

1. Answers to pickup and follow-up questions.
2. Release, hold, re-arm (restart a pull request's review loop) and assign.
   Release, hold and assign go through their existing request kinds. A
   re-arm request today goes to the drive's mailbox, which is local to the
   host, so the browser cannot write it: build step 5 names the re-arm's
   carrier (a comment by the person that the tick reads, as for a steward
   approval) and its reader, and registers them in the records registry.
3. File: recheck the draft, duplicate search, scope and current authority,
   then create the issue as the person. A duplicate is linked instead of
   creating another. A changed draft requires confirmation again.
4. Approve or refuse a steward proposal: a new `steward-approval` record
   pins proposal id, digest revision, target revision and the person's
   choice. The tick re-reads its existing guards; approval never bypasses
   them. The browser writes it as a comment by the person on the pull
   request or issue the proposal targets, in the structured-answer line
   format (`steward-approval <proposal id>: approve` or `refuse`, the digest
   and target revisions bound in the line); the tick reads it with the
   comment read it already makes for answers, and a repeat of the same
   proposal id and revisions counts once. The tick's next closing report
   acknowledges it, applied or refused with the reason. A stale proposal is
   refused for a fresh review. The record's medium, location, owner and
   reader are registered in the records registry with build step 5.
5. Merge on desktop only, last, through the person's token, with the
   existing merge-ready predicate and a confirmation pinned to the head.

The only new action record kinds are the File draft and steward approval.
An answer, release or hold reuses its existing writer and parser. Refusing
a proposal records the refusal without an effect. No action marks an item
or an outside-code step done: every write has an agent or
[station](../GLOSSARY.md) (a stage of the line, such as a pickup or a
follow-up) on the other side, except the person's own merge.

For a checkable outside-code step, the person's answer requests a follow-up
recheck of the item in [ops-pending](../GLOSSARY.md), the tracker state a
merged item waits in while a person's step outside the code is owed. The
follow-up reads the closing condition
again, records evidence and transitions only when satisfied. A condition
that only the person can attest becomes an ordinary question with “it works”,
“it failed”, “not yet”; the answer is evidence for the follow-up, not a direct
state write. Repeated deliveries share the request id. Failed and not-yet
answers preserve ops-pending and show the next step. This adds a recheck
entry point to today's once-at-merge follow-up decision.

Until the [pass trust boundary](../GLOSSARY.md) (plan item 40: the
mechanisms that tell a comment a pass posts under the person's login from
the person's own) lands, these acts are trusted exactly as `jig send` from a
person's terminal is. The unlock below does not improve what the forge or
line can prove about the author. [Attested classes](../GLOSSARY.md),
decision classes whose answers count only with proof that a person gave
them, remain unavailable until their existing trust requirements are met. GitHub ships
first, Linear next; Jira retains read views until its action transport exists.

### Phone unlock and browser evidence

[ADR-0023](../docs/adr/ADR-0023-browser-actions-use-a-local-unlock.md)
amends the dashboard's phone contract and
[ADR-0019](../docs/adr/ADR-0019-the-dashboard-page-answers-as-the-person.md).
It keeps that record's path, token, HTTPS-or-loopback rule,
content security policy and trust; it adds the acts below, a confirmation
for every act, no merge on a phone and the optional unlock. Phones get the
desktop's sendable acts except merge, using visible controls and the same
confirmation. Phone writes require the private-network HTTPS front; on the
plain HTTP fallback the phone stays read-only. No action depends on hover.
Unlock defaults on for phones and off for desktops, and the choice is a
setting. So is the session's length: 30 minutes by default and at most 4
hours, so a longer value is refused. With the unlock on, the token is
stored only encrypted. With it off, on either device, the token is kept as
ADR-0019 keeps it, in the browser's local storage, and the settings
panel says it is not protected at rest. The page never moves a token into
that storage on its own.

The optional unlock uses **WebAuthn** and its **PRF extension**
([glossary](../GLOSSARY.md)), not a boolean saved after a biometric prompt.
At enrollment, require user verification, evaluate the credential's PRF, and
use its output through the HMAC-based key derivation function (HKDF,
[glossary](../GLOSSARY.md)) to wrap a randomly generated token-encryption
key with authenticated encryption. Each derived key is named by its own
HKDF info label, and each encryption takes its own fresh nonce; build step
5 fixes the labels and the nonce layout with the format version. Bind the
ciphertext to origin, credential id and format version. Persist only
wrapped key, encrypted token, salt, a nonce per ciphertext and credential
id. An unlock evaluates PRF with user verification
required and unwraps the key in memory. A successful round-trip decrypt,
not just `prf.enabled`, is required before offering “store token”.

Use the result for AES-GCM (Advanced Encryption Standard in Galois/Counter
Mode, [glossary](../GLOSSARY.md)) with a fresh nonce for each encryption; no PRF
output or plaintext token is persisted, logged, exported or sent to the host.
The unlocked token exists in page memory for the session's fixed length
(30 minutes by default, at most 4 hours), never extended by activity.
Expiry, page close, explicit lock, credential
removal or origin change drops all references. Every send checks expiry so
suspended background tabs cannot send on resumption. Browser memory and a
compromised page are outside what this protects. A host serving a tampered
page can steal the token while unlocked; WebAuthn proves local presence and
protects a lost or borrowed device, not the host's honesty or a forge author.

Documentation checked on 2026-11-14, before implementation:

| Browser/platform | Primary evidence and result | Design consequence |
| --- | --- | --- |
| Safari on current iOS | [Safari 18 WebKit release notes](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/) added PRF; [Safari 26.4 notes](https://developer.apple.com/documentation/safari-release-notes/safari-26_4-release-notes) separately added PRF with security keys | Support depends on browser and credential provider; do not assume every key works |
| Chrome on Android | [Chromium's stable runtime feature](https://chromium.googlesource.com/chromium/src/+/af3159f6b882f925733a6dae791cd2f075937e80/third_party/blink/renderer/platform/runtime_enabled_features.json5) enables `WebAuthenticationPRF`; [the shipping discussion](https://groups.google.com/a/chromium.org/g/blink-dev/c/iTNOgLwD2bI) distinguishes browser support from authenticator support | A stable browser feature alone does not prove the selected Android credential returns a usable result |
| Other browsers and embedded views | [The WebAuthn specification](https://w3c.github.io/webauthn/#prf-extension) makes PRF credential-dependent | Feature-detect and run the same round-trip; never infer support from a user-agent string |

This is a source review, not a physical-device test. Before action code is
built, record a successful create/get/decrypt round-trip, rejection, expiry,
and reload on current stable iOS Safari and Android Chrome, naming browser,
OS and credential provider versions. An unsupported browser or credential
shows “Unlock unavailable” and stores no token under the unlock; it never
falls back to plain storage on its own, and only the person's turning the
unlock off keeps the token as ADR-0019 does. Losing the credential
requires a new token and enrollment, not recovery material stored beside the ciphertext.
Enrollment, rotation and deletion have visible controls; deletion removes the
ciphertext and tells the person to revoke the forge token separately.

## Build order

Every step is a separate shippable pull request and an issue under epic
#1177; a step starts when the steps it names have merged. The overview's
visual design round (#1182) precedes its user interface.

1. **Record, lanes and ranking, reporting only.** Add the repository record
   schema and validator, the tracker snapshot contract and its tick path that
   writes `allocation_lane_epoch` transitions, the weights file's
   reader with its `lanes` section (its `accounts` section is #1402's; the
   step that lands first adds the shared reader), the `allocation_charge`
   table with the claim path's charge write, the `allocation_week` table
   and the weekly counters and opening debt derived from them, the
   `allocation_lane_epoch` table and its revision in the ranker's input hash, the pure
   ranker (read-only over those inputs) and the `priorities` skill. The
   ranking only reports: the tick report and `jig dispatch`'s status show
   the shortlist, each lane's share and the floor owed beside what dispatch
   started, and dispatch's selection does not change. Prove a charge is
   counted once per claim id; equal input hashes give equal output;
   inherited rank, duplicate membership and unknown facets; `urgent` and
   `bug-high` ahead and uncounted; `bug-other` never ahead of an objective
   lane on a tie; a weight of 0 taking a lane out; an invalid weights file
   failing closed; the sample week above reproduced; peripheral debt; and
   disagreement reports. Site fields are not required by the host.
2. **Admission by lanes and the shortlist, opt-in.** After step 1's reports
   have run on Jig long enough to compare them with what dispatch started,
   add a host setting, off by default, under which the dispatcher takes its
   next starts in shortlist order and by lane shares, as overlap-aware
   admission reports its costs (#1229) before it enforces them (#1232).
   The lane decides which work is owed the next start; overlap-aware
   admission still decides whether that work may start now. Prove that with
   the setting off selection is unchanged, that with it on the starts
   follow the sample week's order, that a changed weights file changes the
   next tick, and that capacity stays the host's (load and account quota):
   no lane holds a slot open.
3. **Progress review trial.** After the steward's fixes land (#953, #924
   and #925, then #954, #955 and #956), add the mechanical digest,
   registered records, bounded scheduled stage, the `priorities` skill's
   on-demand review, the `epics-in-flight` measure and closing report
   behind host opt-in. Prove changed time buckets trigger no-movement
   findings, unchanged input reuses output, partial data never claims
   absence, every report includes Urgent and the epics-in-flight
   recommendation follows its defaults. Run on Jig and one consumer
   repository; record whether proposed fixes and decisions were useful and
   duplicate-free before widening adoption.
4. **Overview read view.** After the visual design round, render the typed
   facts and relations in the existing dashboard, including all required
   sections (the follow-up debt view among them), statuses, epic issue/PR
   pairs and clearable options. Test keyboard, touch, phone widths,
   stale/partial sources and distinct reference kinds.
5. **Browser actions and unlock.** Once the physical-device probes above
   pass, implement actions in the stated order, GitHub first then Linear,
   on ADR-0019's path. Name the re-arm's carrier and reader and the derived
   keys' labels and nonce layout; cap the unlock session at 4 hours; add the
   page's module to the outbound-call boundary check's allow list
   (`scripts/check-outbound-boundary.ts`, which
   [the outbound-call design](outbound-calls.md) adds). Add the File draft
   and steward approval records and the ops-pending follow-up recheck.
   Test duplicate sends, changed heads, stale proposals, unauthorized acts,
   PRF absence, expiry after suspension, a session length above the cap,
   refusal below the budget share or on a stale balance, and phone refusal
   to merge or write over HTTP.
6. **Hub level.** With the hub ([control plane design](control-plane.md),
   [ADR-0016](../docs/adr/ADR-0016-an-optional-hub-for-hosts-that-keep-authority.md)),
   add the site priorities record and overview level using its source feed
   and the [leases](../GLOSSARY.md) it grants a host (each a short-lived
   record of which host owns a launch). Prove individual declarations
   stay on hosts and an unavailable hub leaves repository ranking whole.
7. **M9 adoption.** Only after both trial repositories validate the
   practice (steps 2 and 3), move the operated mechanism into M9 guidance
   and mappings, then define evidence-based maturity criteria and update
   the audit. Until then the design adds no plugin hook and no practice
   module.

## Left out

This design does not build ranking, the review stage, dashboard components or
browser writes. It does not select a person's next item, change dispatch's
start authority before the opt-in of build step 2, reserve slots for a lane,
grant the steward more remit, or settle the pass trust boundary. The visual brief and design round are subsequent work. A browser without
a usable PRF result sends nothing while the unlock is on; the person's turning
the unlock off, a setting they choose, keeps the token in plain local storage
and the settings panel says so. Support is never obtained by moving the token
there on the page's own. The hub remains optional.
