# Declared priorities, a progress review and the overview: design

**What problem this solves.** A person can see individual failures without
seeing whether their goals are advancing. An epic's priority does not reach
its children, and written priorities disagree with the tracker's fields.
With this built, a declared purpose and a reproducible ranking explain the
shortlist, a scheduled review spots lack of progress across work, and one
overview shows the goals, activity and decisions together.

This is the design of [plan.md](plan.md) item 56. None of it is built.
The person reviews this design before implementation; the overview's visual
design round follows that review. It extends [M9's computed prioritization
invariant](../modules/M9-tasks-memory/README.md#computed-prioritization),
not its scored criteria. The review pass is named **progress review**
([glossary](../GLOSSARY.md)). It becomes part of M9 after a host opt-in
trial on Jig and one consumer repository proves it; no new practice module
or audit score is introduced now.

## How it works

### One priorities record, each level whole

A **priorities record** ([glossary](../GLOSSARY.md)) states objectives in
one versioned format, `priorities/v1`. Its envelope has `level` (`site`,
`repository`, `individual`), `scope`, `revision`, `objectives`, `limits`
and `peripheralFloor`. Each objective has a stable `id`, `class` (`core`,
`tactical`, `peripheral`), `purpose`, a verifiable `endState`, `owner`,
`epics` (tracker scope plus keys or label selectors), and either
`capacityShare` or `capacityLimit`. Shares are rational fractions of objective-work starts; limits are integer
simultaneous slots. A limit-only objective receives an equal part of the
residual share after explicit shares at that level. With no limit-only
objectives the residual is unreserved; it lends capacity to ready objectives
in record order without changing their declared shares. With zero residual,
a limit-only objective has no entitlement but remains in the shortlist for a
person to choose. These are schema-defined rules, not silent normalization. `owner` is a role at site and
repository levels; only the host's individual record names a person.
The schema rejects unknown fields, duplicate ids, empty selectors, negative
values, shares above one, and a share total above one at a level.

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
replacement by a direct selector. Broader declarations never override narrower limits.
Effective concurrency is the intersection of applicable limits and available
host slots. Each level has its own allocation counters: a proposed start must
respect every applicable cap and is charged once at each applicable level.
The lowest applicable objective share is its effective entitlement; unused
share remains unreserved rather than being redistributed into the record. An infeasible
intersection (including floors exceeding available shares) is reported and
blocks use of that revision for allocation; the last valid revision remains
visible with its age. No reader silently renormalizes a person's choices.
A host never transmits its individual declarations or identities to a site;
the site receives aggregate capacity and objective progress only.

`peripheralFloor` is a required positive share for a nonempty peripheral
class. It reserves a minimum of the capacity available to objective work,
after urgent work and assigned bugs. If peripheral work is blocked or absent,
other ready work may borrow it; the next ready peripheral work receives the
accumulated entitlement. The overview shows borrowed share, unmet floor and
the reason. No floor promises capacity when all slots are occupied by urgent
work, bugs or stricter personal limits.

The `priorities` skill prepares a change through a pull request for a
repository record, validates it, and shows the resulting shortlist diff.
For a host record it prepares a local diff for its owner, never a pull
request containing personal identities. Site changes use the hub's operator
configuration procedure. The skill never launches work or changes tracker
Priority fields. Initial records are authored from the person's stated goals,
not inferred from the order of a plan page. The plan remains the explanation;
the committed record supplies the weights a rule reads.

### Computed ranking proposes a shortlist

The mechanical ranker takes an immutable tracker snapshot, the effective
priorities revisions, a capacity snapshot, and an explicit `asOf` timestamp.
Its output records all input hashes, the algorithm version and the explanation
for each position. It makes no model call. The tracker interface normalizes
GitHub, Linear and Jira priorities, parents, blockers and states; a missing
facet stays unknown and appears as a gap, never as low priority.

Membership is derived from the declared epic keys or labels and their live
children. At each applicable level an item's **allocation owner** is the
first matching objective in that record's explicit order. Only that owner
may include the item in its ready pool, consume its share or concurrency
limit, or count its start toward the class floor. Other objective memberships
are reporting relations only. Ownership is derived before ranking and pinned
to each claim's input revision; an overlapping core-owned item cannot be
selected through a peripheral objective or repay its floor. Cycles, ambiguous
tracker scopes and unreadable
parentage are reported as incomplete evidence and excluded from allocation.
An epic's effective rank reaches its children: a child's own ordinary Priority
orders siblings and does not erase the epic's entitlement.

The shortlist is computed in this order:

1. Apply existing start guards, holds, blocker rules, claims and personal
   limits. Keep excluded work in the report with its reason. Never loosen a
   guard to fill a slot.
2. Place eligible Urgent issues first, across every objective and outside
   objectives. Assigned bugs follow in tracker Priority order, independent
   of objective membership. A bug that is Urgent occupies only its Urgent
   position. Stable ties use tracker scope then canonical key.
3. Allocate remaining prospective starts by weighted fair allocation to
   ready objectives under the concurrent caps. For the next start let `N`
   be objective-work starts already charged in the current UTC week plus
   tentative starts in this computation, and `n[o]` the same count for
   objective `o`, counting only starts allocated to that objective. Let `D0`
   be the immutable debt at this week's opening and `P` all peripheral-owned
   starts this week, including tentative starts. Outstanding carried debt is
   `max(0, D0 - P)`; credit toward this week's floor is `max(0, P - D0)`.
   Restrict to the ready pools of peripheral allocation owners whenever
   outstanding debt is positive or
   `peripheralFloor * (N + 1) - max(0, P - D0) > 0`.
   If none are eligible, lend the slot and report the unmet floor. Within
   the eligible set choose the largest deficit `share[o] * (N + 1) - n[o]`;
   tie by record order then id. At coincident levels charge once; at distinct
   levels check the floor restriction independently and choose from their
   intersection. If it is empty, report an allocation conflict rather than
   guessing which floor wins. Residual unreserved share is lent in record
   order when no positive-deficit objective is ready. A concurrent cap is a
   hard ceiling; an entitlement is a proposal, never a launch.
4. Within an objective, order epics by their declared position, then their
   tracker Priority; order eligible children by Priority then canonical key.
   Emit the eligible unallocated work afterward in the same deterministic
   order. Work outside every objective remains visible as unallocated work,
   after declared work; the person may still choose it.

A start means a successful pickup claim, irrespective of eventual duration
or outcome; shares distribute starts, not processor time or hours. Urgent and bug
bypass starts are excluded from `N` and the objective counters. A completed
launch releases its concurrency charge but keeps its weekly allocation charge. An unsuccessful claim consumes no charge; a successful
claim records one immutable charge keyed by claim id. Replays count it once.
Changing shares does not rewrite historical charges. At a week boundary,
set the next week's opening debt to
`max(0, peripheralFloor * N - max(0, P - D0))`, capped at
`peripheralFloor * N` for the completed week, then zero weekly charges.
The opening `D0` never decreases during the week; repayment is derived from
`P`, so a peripheral start cannot both repay debt and count in full toward
the new floor. For example, with opening debt 1 and two peripheral starts,
one repays debt and one earns current-week floor credit. At each boundary
replace, never add to, the opening debt with the completed week's unmet
entitlement; old unpaid debt is discarded, so absence cannot accumulate an
unbounded claim over later work.
These values belong to the ranking input, not hidden process state.

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

The progress review reads a mechanical digest first. Like the
[steward](../docs/adr/ADR-0018-the-steward-proposes-within-a-remit-the-host-widens.md),
it proposes; the tick or the person acts. It never picks, starts, answers,
re-ranks, files, changes a priority, or changes configuration. The steward
keeps individual stopped items. Its digest and reliability fixes, followed
by its remit fixes, land before this pass is enabled.

The proposed `progress_review` host setting has `enabled`, `cadence`,
`hourly_budget` and `max_runtime`, following the steward's existing stage
shape. The owner host schedules the stage; the same skill runs on demand.
A hash of priorities revisions, tracker snapshot, ranking output, line record
revisions and outcome-log watermark suppresses unchanged scheduled runs.
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
`progress_review_finding`, and `file_draft`, with the same owner, retention,
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
| `idle-capacity` | Free eligible slots, ready references, limits and exclusion reasons | Activity and insights |
| `scope-growth` | Approved plan revision, added children, and work outside all objectives | Goals and insights |
| `decision-owed` | Existing decision id, owner role, age, blocked references and current options | Needs-you and the chat digest |

The tick validates the closed schema and re-reads target revisions before
accepting a proposal. It publishes facts only; it cannot turn a reason into
a command. A new fix needs a `file_draft` prepared through the filing skill's
taxonomy, priority, duplicate and scope checks, with their evidence and age.
The draft is a separate record referenced by `repeated-hold`; it is not an
issue and reserves no tracker key. A fix with an existing issue links it.
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

The overview is a view inside the existing dispatch dashboard (item 42),
then inside the hub (item 49), not a second dashboard or per-run report.
It works in an ordinary browser. A level switch selects repository, individual
or site. A standalone host offers its supported levels; site is absent until
the hub ships. Individual filtering is local to an authorized host view and
never expands the source feed's audience.

Every issue or pull-request reference has `kind`, scoped `id`, `state`,
`url`, and `counterparts` (typed references by id, with an empty list when
known absent and `unknown` when unread). A fact relation has `subjects`,
`relation` (a closed verb such as `waits-on`, `implements`, `blocks`),
`objects`, `count`, `observedAt` and `sourceRevision`. Counts are derived from
those sets, with a separate total and pagination cursor for truncated sets.
Sentences are rendered from facts; the planner and progress review author
this contract. Free-text interpretation is detail, never the source of a
status, count, action target or relation.

| Section, in display order | Data it reads |
| --- | --- |
| Goals as stated | Effective priorities record: purpose, end state, owner role, share/limit, floor and rank explanation |
| Urgent, always tracked | Full normalized Urgent tracker set, start exclusions, claims and last stage event |
| Epic progress | Tracker child set, approved plan revision, acceptance and stage events; canceled children shown separately |
| Assigned bugs, by priority | Assigned normalized bug set with tracker Priority and claim/PR counterparts |
| Current activity | Launches, session presence, drive ledger, holds, dependency edges and outcome log |
| Insights | Validated progress-review findings and source ages |
| Recommended systematic fixes | Repeated-hold findings and existing issues or checked File drafts |
| Decisions owed | Registry needs and decision-owed ordering; same ids as Needs-you and the chat digest |

Each epic opens a table pairing issues with their pull requests, including
multiple or absent counterparts. Its stage totals distinguish implementation
before a PR, PRs being driven, PRs parked, waiting on other items and waiting
on the person. Stage membership is exclusive for totals; dependency relations
remain visible beside it. Precedence is done, ready to merge, parked on you,
waiting on other items, stalled, actively progressing. Ready uses the existing
merge-ready predicate. Stalled requires a crossed no-movement deadline with
complete observations. Unknown or stale evidence gets its own neutral mark,
never a successful or stalled status invented from absence.

Every mark has an icon, colour and word: actively progressing, stalled,
parked on you, waiting on other items, ready to merge, done. Issue and PR
references use distinct icons and labels, links and hover panels. Default
text is short; desktop hover exposes counts and detail, and a visible details
button exposes exactly the same information on touch and keyboard.
Recommended options have a subtle frame plus the word “Recommended”; a picked
option has a stronger state. `Clear pick` and a second tap on the picked
option both clear it. Selection alone sends nothing. These changes arrive
with the overview design round; existing Needs-you rows do not change now.

### Actions: the person's browser makes one write

The action path builds only after the browser-write path and its decision
record land. Each action is one existing write the line reads, sent directly
from the browser to the forge or tracker as the person, with no request to a
host. Before sending, a confirmation shows target, action, selected option,
exact payload and expected effect. Refresh the target revision and permission
before confirming; a changed decision or head invalidates the confirmation.
A lost response is unknown, not failure: re-read for the request id before
retrying. Idempotency keys use the existing writer's identity where supported.
The same governed transport obligations apply to browser calls; budgets can
only cover what the browser observes, so server rate-limit responses remain
authoritative and are shown with their reset time.

Acts become sendable in this order:

1. Answers to pickup and follow-up questions.
2. Release, hold, re-arm and assign, through the existing request kinds.
3. File: recheck the draft, duplicate search, scope and current authority,
   then create the issue as the person. A duplicate is linked instead of
   creating another. A changed draft requires confirmation again.
4. Approve or refuse a steward proposal: a new `steward-approval` record
   pins proposal id, digest revision, target revision and the person's
   choice. The tick re-reads its existing guards; approval never bypasses
   them. A stale proposal is refused for a fresh review.
5. Merge on desktop only, last, through the person's token, with the
   existing merge-ready predicate and a confirmation pinned to the head.

The only new action record kinds are the File draft and steward approval.
An answer, release or hold reuses its existing writer and parser. Refusing
a proposal records the refusal without an effect. No action marks an item
or an outside-code step done: every write has an agent or station on the
other side, except the person's own merge.

For a checkable outside-code step, the person's answer requests a follow-up
recheck of the item in ops-pending. The follow-up reads the closing condition
again, records evidence and transitions only when satisfied. A condition
that only the person can attest becomes an ordinary question with “it works”,
“it failed”, “not yet”; the answer is evidence for the follow-up, not a direct
state write. Repeated deliveries share the request id. Failed and not-yet
answers preserve ops-pending and show the next step. This adds a recheck
entry point to today's once-at-merge follow-up decision.

Until the pass trust boundary lands, these acts are trusted exactly as
`jig send` from a person's terminal is. The unlock below does not improve
what the forge or line can prove about the author. Attested classes remain
unavailable until their existing trust requirements are met. GitHub ships
first, Linear next; Jira retains read views until its action transport exists.

### Phone unlock and browser evidence

[ADR-0023](../docs/adr/ADR-0023-browser-actions-use-a-local-unlock.md)
amends the dashboard's phone contract. Phones get the desktop's sendable acts
except merge, using visible controls and the same confirmation. Phone writes
require the private-network HTTPS front; the plain HTTP fallback is read-only.
No action depends on hover. Unlock defaults on for phones and off for desktops;
both the choice and the 30-minute session length are settings. Turning
unlock off on a phone keeps that phone read-only and removes its stored
token; it never enables unprotected phone writes. A desktop with unlock off
uses explicit session-only token entry with no persistent token storage.

The optional unlock uses **WebAuthn** and its **PRF extension**
([glossary](../GLOSSARY.md)), not a boolean saved after a biometric prompt.
At enrollment, require user verification, evaluate the credential's PRF, and
use its output through the HMAC-based key derivation function (HKDF,
[glossary](../GLOSSARY.md)) to wrap a randomly generated token-encryption
key with authenticated encryption. Bind the ciphertext to origin, credential
id and format version. Persist only wrapped key, encrypted token, salt,
nonce and credential id. An unlock evaluates PRF with user verification
required and unwraps the key in memory. A successful round-trip decrypt,
not just `prf.enabled`, is required before offering “store token”.

Use the result for AES-GCM (Advanced Encryption Standard in Galois/Counter
Mode, [glossary](../GLOSSARY.md)) with a fresh nonce for each encryption; no PRF
output or plaintext token is persisted, logged, exported or sent to the host.
The unlocked token exists in page memory for a fixed 30 minutes by default,
never extended by activity. Expiry, page close, explicit lock, credential
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
shows “Unlock unavailable” and remains read-only on phones; it never stores a
plaintext token as fallback. A desktop can use the existing explicit
session-only token entry without persistence. Losing the credential requires
a new token and enrollment, not recovery material stored beside the ciphertext.
Enrollment, rotation and deletion have visible controls; deletion removes the
ciphertext and tells the person to revoke the forge token separately.

## Build order

Every step is a separate shippable pull request. This design and its build
order receive fresh-context critique and the person's review before step 1;
the overview's visual design round follows this document and precedes UI work.

1. **Record and rank, read-only.** Add the repository record schema, validator,
   tracker snapshot contract, pure ranker and `priorities` skill. Prove equal
   input hashes give equal output, inherited rank, duplicate membership,
   unknown facets, urgent/bug bypass, cap intersection, peripheral debt and
   disagreement reports. Site fields are not required by the host.
2. **Progress review trial.** After the steward's digest, reliability and
   remit fixes land, add the mechanical digest, registered records, bounded
   scheduled stage, on-demand skill and closing report behind host opt-in.
   Prove changed time buckets trigger no-movement findings, unchanged input
   reuses output, partial data never claims absence and every report includes
   Urgent. Run on Jig and one consumer repository; record whether proposed
   fixes and decisions were useful and duplicate-free before widening adoption.
3. **Overview read view.** After the visual design round, render the typed
   facts and relations in the existing dashboard, including all required
   sections, statuses, epic issue/PR pairs and clearable options. Test keyboard,
   touch, phone widths, stale/partial sources and distinct reference kinds.
4. **Browser actions and unlock.** After the existing browser-write path
   merges and the physical-device probes above pass, implement actions in the
   stated order, GitHub first then Linear. Add the File draft and steward
   approval records and the ops-pending follow-up recheck. Test duplicate
   sends, changed heads, stale proposals, unauthorized acts, PRF absence,
   expiry after suspension, and phone refusal to merge or write over HTTP.
5. **Hub level.** With the hub, add the site priorities record and overview
   level using its source feed and owner leases. Prove individual declarations
   stay on hosts and an unavailable hub leaves repository ranking whole.
6. **M9 adoption.** Only after both trial repositories validate the practice,
   move the operated mechanism into M9 guidance and mappings, then define
   evidence-based maturity criteria and update the audit. No speculative
   plugin hook or new module ships in this design pull request.

## Left out

This design does not build ranking, the review stage, dashboard components or
browser writes. It does not select a person's next item, change dispatch's
start authority, grant the steward more remit, or settle the pass trust
boundary. The visual brief and design round are subsequent work. Broader
browser support is obtained by a usable PRF probe or stays read-only, never
by weakening token protection. The hub remains optional.
