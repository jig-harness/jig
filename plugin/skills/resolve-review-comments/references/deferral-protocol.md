# Deferral protocol

What to do with a review finding that is **real but does not belong in this pull
request**. Consumer values are declared in the repository's
`.config/jig.yaml`: `review.deferral_team`, `review.repo_label`,
and `review.taxonomy` determine where issues go and which labels apply. The
`pr-followup` and `epic` labels named below are the defaults of the `followup`
and `epic` roles in `issue_tracker.labels`; read them as the repository's own
labels for those roles. The shipped tracker adapter uses Linear; another
adapter can implement the same find/create/update contract.

`<skill-dir>` in the commands below is this skill's directory, the parent of
this `references/` directory. Run the commands from the repository root.

A deferral is the one outcome that leaves work behind after the thread closes.
That makes it the outcome most likely to be lost, so it is the one with the
strictest contract: nothing is deferred without a tracked issue, and no thread
resolves before that issue's link is on it.

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
   uses the Linear adapter directly because an executable cannot call tools that
   exist only inside an agent turn. Do not substitute a repository-specific
   tracker command for this maintained batching mechanism.
1. **File the issue** (see below). By default this is an entry in the
   per-PR+Type **batch** issue — `defer-batch.ts` does the find-or-create and
   the append (§ [Batching is the default](#batching-is-the-default)). For
   the justified-individual exception, first check that an issue does not
   already exist: search open issues for the finding's subject **and** walk
   the originating issue's tracker relations (`blocks`/`blocked by`/related) —
   scope-widening findings are often already tracked by a neighbouring
   ticket, and a duplicate splits the audit trail. If found, reply with the
   existing issue's link instead of filing.
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
issues fragment prioritisation and bury obligatory work. By default every
deferral lands in the per-PR+Type batch issue. An individual issue is the
exception, taken only when the round report records why:

- the finding needs its **own design decision** (a batch entry that grows a
  discussion is split out the same way);
- its fix sizes **above `small`**;
- it belongs to a **different owner or domain** than the rest of the batch.

No justification in the round report, no individual issue.

The batch key and contract:

- **One batch issue per PR and Type**, titled
  `PR #NNNN <type> review follow-ups` (e.g. `PR #42 bug review follow-ups`).
  The Type is in the title because it is the lookup key. Its description
  lists every batched finding: the thread URL, the reviewer's finding quoted,
  and the deferral reason — each entry self-contained enough to act on
  without re-reading the PR.
- **Why per Type**: the taxonomy's Type group is pick-one and Type is chosen
  from the finding, so a batch mixing incompatible Types (a correctness bug
  and a docs correction) cannot be labeled honestly. One batch per PR and
  Type is still far fewer issues than one per finding.
- **One batch issue per PR and Type means across all rounds**, and rounds
  arrive per push — the helper below finds the existing open batch under the
  key before creating one. A second issue under the same key recreates
  exactly the tracker noise batching exists to eliminate.
- Each deferred thread's reply links whichever issue carries it — several
  threads may link the same batch issue.

The mechanized path — find-or-create under the key, correct labels and parent
applied, idempotent append, and it prints the link for the `**deferred**`
reply:

```bash
bun "<skill-dir>/scripts/defer-batch.ts" <PR#> <type> \
  --thread-url <url> --reason '<why deferred>' \
  --severity <blocker|high|medium|low|unknown> --category <cat|unknown> \
  --originating <originating-issue> <<'EOF'
<the reviewer's finding, quoted verbatim>
EOF
```

A finding emitted only in the reviewer's sticky PR conversation comment has
no inline thread URL. Use the same helper with the comment permalink and the
finding's stable fingerprint from the `ai-review-backlog` marker instead:

```bash
bun "<skill-dir>/scripts/defer-batch.ts" <PR#> <type> \
  --comment-url <https://github.com/owner/repo/pull/N#issuecomment-ID> \
  --fingerprint <marker-safe-fingerprint> --reason '<why deferred>' \
  --severity <blocker|high|medium|low|unknown> --category <cat|unknown> \
  --originating <originating-issue> <<'EOF'
<the reviewer's finding, quoted verbatim>
EOF
```

The finding is stdin, never an argument — review text contains backticks and
`$(...)` that a shell argument would evaluate before the script runs (the same
reason reply bodies arrive via stdin). The append is idempotent on
the inline thread URL, or on the sticky comment plus fingerprint for a
summary-only finding, so a crashed round re-runs safely and multiple findings
in one sticky comment remain distinct. `--no-parent` covers the
domain-mismatch judgment under [Parent](#parent); `--dry-run` previews without
writing.

`--severity` is **required**: silently discarding severity creates follow-ups
without actionable priority. Pass the reviewer's own severity marker, or
`unknown` when absent. The adapter sets issue priority, escalating an existing
batch's priority but never downgrading it. A deferred `blocker`
is a contradiction (see [When to defer](#when-to-defer) above — it should
have been fixed or escalated, not deferred); the script warns loudly when
one is passed, but still files it, at Urgent priority. `--category` is
**also required**, mirroring `triage-ladder.ts`'s own requirement (step 3 of
[the procedure](../SKILL.md)): an omitted flag is indistinguishable from an explicit
`unknown` and could silently discard a real parsed value the caller already
computed. It is recorded in the entry text only — pass the same value fed to
`triage-ladder.ts --category` (`unknown` when the reviewer emits no
`🏷️ category:` tag).

The batch issue follows every rule below (labels, parent, description fields)
exactly as an individual follow-up would — the helper applies them
mechanically; batching changes the issue count, never the contract.

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

Type is chosen from the finding, not from the parent. A deferred correctness
finding is a `bug` even when the PR that surfaced it was a `feature`. A batch
issue's Type comes from its batched findings, which must all share it — that
is why batches are keyed per PR *and* Type (see above).

### Parent

Parent the follow-up to **the epic that the originating issue belongs to** —
that is, the originating issue's own parent.

**Never parent it to the originating issue itself.** The originating issue is
about to be closed by the PR that is under review. Hanging live follow-up work
off an issue that is about to complete strands the child under a done parent,
and it distorts that issue's scope after the fact: an issue's children should be
the work it was decomposed into, not work discovered while reviewing it.

Resolve the parent by walking up exactly one level, then stop:

| Originating issue | Parent to use |
|---|---|
| Has a parent epic | That epic |
| Is itself an epic (carries the `epic` label) | No parent — same project and milestone |
| Has no parent | No parent — same project and milestone |
| No linked issue at all (PR has no ticket) | No parent — triage |

Do not walk further up to find a grandparent epic, and do not invent an epic to
hold the follow-up. One level up or nothing.

**"Is itself an epic" means the `epic` label, not "has children"** — the two
disagree, and this row picks the label deliberately. Child-bearing is far
weaker evidence than it reads: most issues with children are mid-tree
groupings that have a genuine epic parent of their own, so treating a
non-empty children set as proof files their follow-up parentless and silently
discards the correct parent this table asks for. The epic label is a
[flag label](https://github.com/docomply/jig/blob/main/GLOSSARY.md) that exists to answer exactly this question ("this issue is a
coordination container"), so it is the thing to ask.

The trade, stated because both directions have a real failure mode: under the label rule an epic that nobody
labelled gets its follow-up parented to the grandparent, which is a **labelling
defect with a visible fix** — add the flag. Under a children rule an ordinary
grouping loses a correct parent, which is **silent and unrecoverable** after
the fact. Prefer the failure that announces itself.

One override on the first row: **the epic must actually share the finding's
domain.** A finding that has nothing to do with the parent epic's subject — a
tooling defect surfaced while reviewing a compliance-doc PR, say — does not
belong under that epic just because the table resolves there. File it
parentless, and state in the description why: "no epic shares this domain;
originating issue's epic is <epic> (unrelated)". A topically wrong parent is
worse than none — it distorts the epic's scope and hides the issue from the
people who own its real domain.

### What the epic parent means for closing that epic

An epic is complete when its designed scope is delivered, rather than when
its child count reaches zero. At closure, the consumer's follow-up workflow
moves surviving review debt into its configured debt destination and preserves
provenance with a related link and an explanatory comment. This skill files the
follow-up; it does not close epics or assume a particular debt project.

This does not change the following, each easy to get backwards:

- **New deferrals resolve by the table above, domain-mismatch override
  included** — not a blanket "always parent to the epic". The sweep runs at
  closure, not at deferral. Filing a fresh, epic-domain follow-up straight
  into the debt ledger would lose the epic association the sweep later
  depends on; a domain-mismatched one is filed parentless either way.
- **"Designed scope delivered" is a judgement, not a child count.** The sweep
  will not act on the mechanical check alone: it requires an accepting
  verdict from the repository's epic acceptance review, or a human waiver
  recorded on the epic. Sub-issues marked done whose code never landed are a
  recurring failure, which is why counting them cannot be what authorizes a
  closure.

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
  issue's priority, category is recorded as text only);
- why it was deferred rather than fixed in that PR;
- what a fix would involve, to the extent the round established it.

Also add a **related** link to the originating issue. That is what preserves the
connection the parent field deliberately does not carry: related, not child.

## Worked shape

For a finding on a PR that closes an issue whose parent epic is `EPIC-12`:

- **Parent** — `EPIC-12`
- **Related** — the originating issue
- **Labels** — Type/Size/Repo/context as usual, plus `pr-followup`
- **Description** — thread URL, PR, quoted finding, severity, category,
  deferral reason
- **Thread** — reply naming the new issue, then resolved

## Anti-patterns

- Resolving the thread first and filing the issue "after the round" — the round
  ends, the issue is never filed, and the finding is gone with the thread closed.
- Replying "will follow up" with no link. Unverifiable and untrackable.
- Parenting to the originating issue. See above; this is the specific mistake
  this protocol exists to prevent.
- Filing under `pr-followup` alone, without the mandatory groups. The flag is
  additive; it does not replace Type/Size/Repo.
- Deferring to avoid a hard fix. Deferral is a scope judgement, not an escape
  hatch — the rubric/arbiter decides it on evidence, and an obligatory fix that
  is merely hard stays in scope.
- Deferring optional polish. That is `wont-fix` — no issue, no tracker noise.
  The deferral queue is for work that must happen, or it stops meaning that.
