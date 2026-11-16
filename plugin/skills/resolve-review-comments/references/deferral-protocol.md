# Deferral protocol

What to do with a review finding that is **real but does not belong in this pull
request**. Consumer values are declared in the repository's
`.config/jig.yaml`: `review.deferral_team`, `review.repo_label`,
and `review.taxonomy` determine where issues go and which labels apply. The
`pr-followup` and `epic` labels named below are the defaults of the `followup`
and `epic` roles in `issue_tracker.labels`; read them as the repository's own
labels for those roles. The scripts use the configured tracker interface
on GitHub, Linear and Jira, through each adapter's governed transport.

`<skill-dir>` in the commands below is this skill's directory, the parent of
this `references/` directory. Run the commands from the repository root.

A deferral is the one outcome that leaves work behind after the thread closes.
That makes it the outcome most likely to be lost, so it is the one with the
strictest contract: nothing is deferred without a tracked issue, or, where no
tracker adapter can file one, an entry in the pull request's own
`## Deferred` section ([Deferral without a tracker](#deferral-without-a-tracker));
and no thread resolves before the issue's or the entry's link is on it. A
deferral is therefore never a park.

## Contents

- [When to defer](#when-to-defer)
- [Who decides a deferral](#who-decides-a-deferral)
- [Batching is the default](#batching-is-the-default)
- [Deferral without a tracker](#deferral-without-a-tracker)
- [Filing the follow-up issue](#filing-the-follow-up-issue)
- [Worked shape](#worked-shape)
- [Anti-patterns](#anti-patterns)

## When to defer

Defer only when the finding is **correct**, the work is **obligatory** — it
must eventually happen (a correctness, security, or compliance consequence if
it never does) — and one of these holds:

- fixing it would significantly widen the pull request's scope;
- it needs a decision the agent is not entitled to make;
- it depends on work that is not in this branch.

Not a deferral: a finding that is wrong (reject it, with the reason), one that
is merely tedious (address it), or one that is valid but **optional** —
polish that merely *could* happen is `wont-fix`, with no issue filed (see the
[triage rubric](triage-rubric.md)). Deferring optional polish is what floods
the tracker with `pr-followup` noise until real follow-ups drown in it;
"I would rather not" is not scope.

**A "design tradeoff" is not deferrable when standing policy already picks the
side.** Before deferring a finding as needing a design decision, check whether
a repo-wide stance already resolves it — a compatibility policy, a
minimal-change rule, or a critical guardrail. If policy
decides it, the finding is in scope: apply the policy now (often a
net-negative-line fix) and, if a deferral issue was already filed on the wrong
premise, cancel it with a linked explanation. Consult policy before filing to avoid creating a follow-up for work already
required in this pull request.

**Recurrence is the deferral signal, not round five.** When findings in two
consecutive rounds trace to the same underlying design gap — differently
worded, new thread ids, same root — stop re-answering per-instance and decide
the deferral *then*. The tell is a reply of yours saying "this class of
concern" or citing a prior round. Waiting for more restatements files the same
issue later at a higher round cost.

## Who decides a deferral

Deferring is a scope decision. Clear-cut cases are decided autonomously by the
[triage rubric](triage-rubric.md) — and, where the rubric does not settle it,
by the **Review Arbiter** agent (`jig:review-arbiter`). A human
decides only when the arbiter **escalates**: a genuine product or risk call the
repo's own evidence cannot answer. Escalations are batched into one question at
round end and must not stall the rest of the round — proceed with the in-scope
fixes meanwhile.

Once the deferral is decided, the sequence is fixed and ordered:

0. **Prepare the issue workflow.** Load the consumer's tracker integration and
   canonical vocabulary before manual issue work. The shipped `defer-batch.ts`
   uses the configured tracker adapter because an executable cannot call tools
   that exist only inside an agent turn. Do not substitute a repository-specific
   tracker command for this maintained batching mechanism.
1. **File the issue** (see below). This is an entry in the
   per-PR+Type **batch** issue — `defer-batch.ts` does the find-or-create and
   the append (§ [Batching is the default](#batching-is-the-default)). Search
   the originating issue's tracker relations for an issue already carrying
   the finding before filing; reuse that issue's link when it exists.
2. **Reply on the thread**, opening with the `**deferred**` outcome token, then
   the reason and the issue link:

   ```text
   **deferred** — real, but it needs the connector refactor first; filed the linked follow-up issue.
   ```

3. **Resolve the thread.**

The issue is filed *before* the reply so the reply can carry its link, and the
thread resolves *after* the reply so nothing closes without an audit trail. A
thread left open "because it is deferred" is a defect: the filed issue is the
tracking, and an orphaned open thread means continuous mode never converges.

## Batching is the default

One PR's review rounds produce several deferrals; separate single-sentence
issues fragment prioritisation and bury obligatory work. Every deferral
lands in the per-PR+Type backlog batch issue on every supported tracker.
A batch entry may later become its own planned work; filing the deferral
itself does not add scope to the originating epic.

The batch key and contract:

- **One batch issue per repository, PR and Type**, keyed on a marker the
  helper writes as the **first line** of the issue's description:

  ```markdown
  <!-- defer-batch-key: repo=project pr=4374 type=bug -->
  ```

  The rest of the description lists every batched finding: the thread URL, the
  reviewer's finding quoted, and the deferral reason — each entry
  self-contained enough to act on without re-reading the PR.
- **The title is display-only.** A new batch is seeded as
  `PR #NNNN <type> review follow-ups` (e.g. `PR #42 bug review follow-ups`),
  and nothing ever looks a batch up by it — so **retitle a batch freely** to
  say what it actually contains.
- **Only the first line is the key.** A marker anywhere else in a
  description (quoted in an entry, or shown in a code example in some other
  issue) is not, so the helper never appends to an issue merely because it
  mentions a key.
- **Why per Type**: the taxonomy's Type group is pick-one and Type is chosen
  from the finding, so a batch mixing incompatible Types (a correctness bug
  and a docs correction) cannot be labeled honestly. One batch per PR and
  Type is still far fewer issues than one per finding.
- **Why per repository**: the key carries the repository because consumers
  share one tracker workspace and pull-request numbers collide across them, so
  another repository's batch for the same PR number and Type does not match
  the key. The repository component is `review.repo_label` (or
  `--repo-label`) when supplied, otherwise the repository slug. The issue's
  type facet must agree with its marker; a contradictory type is refused
  rather than silently restamped. Repository and type components embedded
  in the marker must be free of whitespace and of anything that could open
  or close an HTML comment; the helper refuses an unsafe key before writing.
- **One batch issue per key means across all rounds**, and rounds arrive per
  push — the helper below finds the existing open batch under the key before
  creating one. A second issue under the same key recreates exactly the
  tracker noise batching exists to eliminate.
- **Leave the marker line alone, and never blank a batch's description.** The
  key lives there, so a wiped description — or an edited marker — makes the
  batch unfindable and the next round files a fresh one under a key nothing
  can match. Edit prose and entries freely; leave that one line
  byte-for-byte. If the marker is removed or changed while appending, the
  helper refuses to confirm the deferral. Restore the original key and rerun
  before resolving the thread.
- Each deferred thread's reply links whichever issue carries it — several
  threads may link the same batch issue.

The mechanized path — find-or-create under the key, correct facets, labels
and related links applied, idempotent append, and it prints the link for the `**deferred**`
reply:

```bash
bun "<skill-dir>/../../shared/command.ts" --stdin-file finding.txt -- bun "<skill-dir>/scripts/defer-batch.ts" <PR#> <type> --thread-url <url> --reason '<why deferred>' --severity <blocker|high|medium|low|unknown> --category <cat|unknown> --originating <originating-issue>
```

A finding emitted only in the reviewer's sticky PR conversation comment has
no inline thread URL. Use the same helper with the comment permalink and the
finding's stable fingerprint from the `ai-review-backlog` marker instead:

```bash
bun "<skill-dir>/../../shared/command.ts" --stdin-file finding.txt -- bun "<skill-dir>/scripts/defer-batch.ts" <PR#> <type> --comment-url <https://github.com/owner/repo/pull/N#issuecomment-ID> --fingerprint <marker-safe-fingerprint> --reason '<why deferred>' --severity <blocker|high|medium|low|unknown> --category <cat|unknown> --originating <originating-issue>
```

Write the reviewer's complete finding verbatim to `finding.txt` through the
file-writing tool. The wrapper reads that file and supplies literal standard
input to the helper; reviewer text is never shell source. The append is idempotent on
the inline thread URL, or on the sticky comment plus fingerprint for a
summary-only finding, so a crashed round re-runs safely and multiple findings
in one sticky comment remain distinct. `--dry-run` previews without
writing. Follow-ups never receive a parent.

`--severity` is **required**: silently discarding severity creates follow-ups
without actionable priority. Pass the reviewer's own severity marker, or
`unknown` when absent. The adapter sets issue priority, escalating an existing
batch's priority but never downgrading it. A finding of `unknown` severity
files as medium: a finding nothing ranked is not low priority but unranked,
and medium keeps it in the queue until someone ranks it, so it raises a batch
at low or no priority to medium and leaves a higher one alone. Every deferral
path takes the priority from this one mapping
(`scripts/lib/severity-priority.ts`). A deferred `blocker`
is a contradiction (see [When to defer](#when-to-defer) above — it should
have been fixed or escalated, not deferred); the script warns loudly when
one is passed, but still files it, at Urgent priority. `--category` is
**also required**, mirroring `triage-ladder.ts`'s own requirement (step 3 of
[the procedure](../SKILL.md)): an omitted flag is indistinguishable from an explicit
`unknown` and could silently discard a real parsed value the caller already
computed. The batch category is the union of its findings' areas, also
recorded in the entry text — pass the same value fed to
the `--category` option of `triage-ladder.ts` (`unknown` when the reviewer emits no
`🏷️ category:` tag).

The batch issue follows every rule below (labels, links, description fields)
for every finding — the helper applies them mechanically; batching changes
the issue count, never the contract.

## Deferral without a tracker

The batch step files through the configured tracker interface. Before step 1,
read where this deferral goes:

```bash
bun "<skill-dir>/scripts/defer-in-pr.ts" route
```

`defer-batch` means step 1 files as above. `pr-body: <why>` (the
configured adapter cannot file) means record
the finding in the pull request's own `## Deferred` section instead, at every
autonomy level. Write the reviewer's finding verbatim to `finding.txt` with
the file-writing tool, then:

```bash
bun "<skill-dir>/../../shared/command.ts" --stdin-file finding.txt -- bun "<skill-dir>/scripts/defer-in-pr.ts" <PR#> --thread-url <url> --type <type> --severity <blocker|high|medium|low|unknown> --category <cat|unknown> [--size <size>] --reason '<why deferred>'
```

The entry records what the finding is filed as, the values `defer-batch.ts`
takes: `--type`, `--severity` and `--category` are each required, and
`--size` is given when the fix is larger than `small`. The type is chosen
from the finding ([Labels](#labels)), and from `review.taxonomy.types` where
the repository declares them; the category from
`review.taxonomy.categories`, or `unknown`.

A summary-only finding uses `--comment-url <url> --fingerprint <fp>` in place
of `--thread-url`, as for `defer-batch.ts`. The script adds the entry (the
finding quoted, the reason, the source's link, and in its hidden opening
marker the type, severity, category and size) between hidden markers in the
body, by read-modify-write against the body's `updated_at`, so a person's
edits to the body survive; a finding already there is not added twice. It
prints the section's link. Then reply, opening with the `**deferred**` token
and linking the section, and resolve:

```text
**deferred** — real, but it needs the connector refactor first; recorded in the pull request's Deferred section: <link>.
```

The entries are filed later, where an adapter can: `file-deferred.ts`
groups entries by pull request and type through the tracker interface
(`issue_tracker.adapter`), appending to the open batch for that key or filing
one when none exists, with the
`followup` role's label and every facet the tracker keeps: the type the entry
records, the highest priority its findings' severities map to (`unknown` as
medium), their union of categories, and the size, else `small`. The issue's
description carries every finding's severity and category. Where the repository's label taxonomy requires a group
beyond the size (a `repo` group, say), it adds that group's label from the
change-area catalog (`drive.change_areas_catalog`): the tracker labels of the
areas whose own globs match the file the review thread is on, never the
areas they imply, and only when those areas carry exactly one label of the
group, compared ignoring case. It never guesses one: a summary finding (on
no file), a file no area covers, or areas carrying none of the group's labels
or more than one, leaves the entry in the section for a person to file
through `/jig:file-issue`, the run's output naming the group it lacks, and
the other entries are filed. It replaces each entry with its issue's link.
Run it from
the repository's own post-merge step, or on a pull request closed without
merging:

```bash
bun "<skill-dir>/scripts/file-deferred.ts" <PR#>
```

Each issue it files carries the entry's identity line (its source and, for a
summary finding, its fingerprint) and a digest of the text it was filed
from. It reuses an issue whose body already carries that identity line (a
run stopped after filing it), unless the entry has been corrected since that
issue was filed: then it reports the issue as filed but not recorded and
leaves the correction in the body. It reads each entry afresh
before filing it, so a correction made during the run is what gets filed,
prints each filing as it is made, and reports a filing as not recorded when
its entry was removed, changed or filed as another issue in the meantime.
An entry that records no type or severity, deferred before entries recorded
them, or one whose type or size the repository does not have, stays in the
body and is reported for a person to file through `/jig:file-issue`; the
other entries are filed. It exits `3` when entries remain because no adapter
could file them or a person files them. The body's write is
not atomic against a person's own save of the body, so the script also
checks every resolved thread whose `**deferred**` reply links this pull
request's section, and every summary finding whose `**deferred**` answer
links it (by its fingerprint): one whose entry is gone is named, and it
exits `4`. Only an answer from an owner, member or collaborator counts, and
only a link to this pull request's own `#deferred` section. A thread
whose comments run past one page cannot be checked, and the run fails with
exit `1` rather than passing it unread. Restore that entry from
the reply, or file the finding by hand. With no
tracker at all, the entries stay in the merged pull request's body for a
person to file.

## Filing the follow-up issue

### Labels

The follow-up issue carries the full mandatory label set for the workspace —
Type, Size, Repo, plus context labels — exactly as any other issue. It is a
normal issue that happens to have come from a review.

In addition it **must** carry `pr-followup`, the flag that records that
provenance. Apply it to nothing else: `pr-followup` means "this exists because a
reviewer found it in a PR and we chose not to fix it there". It is persistent —
it stays applied after the follow-up ships, because it permanently records where
the issue came from.

Type is chosen from the finding, not from the originating issue. A deferred correctness
finding is a `bug` even when the PR that surfaced it was a `feature`. A batch
issue's Type comes from its batched findings, which must all share it — that
is why batches are keyed per PR *and* Type (see above).

Through the tracker interface (`file-deferred.ts`) the type, the priority
and the size are the issue's facets, written wherever the tracker keeps
each (`issue_tracker.facets`), so the script names no type, size or priority
label itself. The other required groups' labels come from the change-area
catalog, as [Deferral without a tracker](#deferral-without-a-tracker) says.

### Links and backlog

A follow-up enters the backlog and is never a child of the originating issue
or its epic. Add native `related` links to both, using the tracker interface
as [ADR-0015](https://github.com/jig-harness/jig/blob/main/docs/adr/ADR-0015-relationships-live-in-the-tracker.md)
requires. A prose mention is useful context, never a substitute for the
relation.

Resolve the nearest epic in the originating issue's parent chain:

| Originating issue | Related links |
|---|---|
| Has an ancestor epic | Originating issue and the nearest epic |
| Is itself an epic | That epic |
| Has no ancestor epic | Originating issue |
| No linked issue at all | No originating relation; backlog |

An epic is identified by its configured epic label **or native epic issue
type**, never merely by having children. A mid-tree grouping can have
children without being an epic. A cycle or unreadable ancestry cannot prove
which epic owns the origin; report it rather than guessing a relation. The
links preserve provenance even when the
finding concerns a different domain from the epic; they do not add it to the
epic's designed scope.

Existing follow-ups are not backfilled. A previously parented `pr-followup`
is a tail the closure workflow extracts, preserving its related link and an
explanatory comment. Person-only checks also leave at closure for one
standing person-checks list. This skill files review debt; it does not close
epics or move their tails. Closure still requires an accepting verdict on
designed scope or a person's waiver, never a count of children.

### Description

The description records where the finding came from, so the follow-up is
reviewable without re-reading the PR:

- a link to the **originating review source** — either the inline thread (the
  `url` field from `list-unresolved-threads.ts`) or the sticky PR conversation
  comment carrying a summary-only finding;
- the pull request, and the originating issue identifier;
- the reviewer's finding, quoted;
- the finding's **severity** and **category** (`--severity`/`--category`,
  always rendered — see the command above; severity also sets the batch
  issue's priority, categories are unioned across the batch);
- why it was deferred rather than fixed in that PR;
- what a fix would involve, to the extent the round established it.

Add the native **related** links described above, never a parent.

## Worked shape

For a finding on a PR that closes an issue whose parent epic is `EPIC-12`:

- **State** — backlog; no parent
- **Related** — the originating issue and `EPIC-12`
- **Labels** — Type/Size/Repo/context as usual, plus `pr-followup`
- **Description** — thread URL, PR, quoted finding, severity, category,
  deferral reason
- **Thread** — reply naming the new issue, then resolved

## Anti-patterns

- Resolving the thread first and filing the issue "after the round" — the round
  ends, the issue is never filed, and the finding is gone with the thread closed.
- Replying "will follow up" with no link. Unverifiable and untrackable.
- Parenting to the originating issue or its epic. A deferral preserves
  provenance through related links and never enlarges their designed scope.
- Filing under `pr-followup` alone, without the mandatory groups. The flag is
  additive; it does not replace Type/Size/Repo.
- Deferring to avoid a hard fix. Deferral is a scope judgement, not an escape
  hatch — the rubric/arbiter decides it on evidence, and an obligatory fix that
  is merely hard stays in scope.
- Deferring optional polish. That is `wont-fix` — no issue, no tracker noise.
  The deferral queue is for work that must happen, or it stops meaning that.
- Clearing a batch's description, or editing its `defer-batch-key` marker line.
  That is where the cross-round key lives, so the batch stops being findable
  and the next round files a duplicate. The title, by contrast, is safe to
  change — that is the whole point of keying on the marker.
