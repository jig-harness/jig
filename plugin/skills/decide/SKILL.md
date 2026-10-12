---
name: decide
description: "Resolve a technical dilemma: check it against the decisions the repository already made, frame the options, rule or escalate to a human, and record the outcome where the next session finds it."
argument-hint: "<the dilemma, in words> | <issue-key>"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
  - Write
  - Edit
  - Task
---

# Decide — one ruling, grounded, routed

A technical dilemma arrives mid-flight and needs a decision or a sign-off. The
reasoning capacity to answer it already exists (an architect agent). What is
usually missing is everything around the call: nothing obliges the answer to
be checked against the decisions this repository already made, nothing fixes
what a ruling must contain, nothing says when an agent may decide versus when
the call belongs to a human, and nothing says where the outcome lands so the
next session can find it.

This skill is that contract. Its most valuable outcome is the cheapest one:
**discovering the question was already settled** and citing the ADR
([architecture decision record](https://github.com/docomply/jig/blob/main/GLOSSARY.md)) that settled it. The
records themselves follow Jig's ADR practice module
([M5](https://github.com/docomply/jig/blob/main/modules/M5-adr-practice/README.md)):
this skill checks a new question against them first, and hands a ruling
that clears the [ADR bar](#phase-4--route-the-outcome) to `/jig:adr`.

> **This skill rules and routes. It does not implement.** The decision it
> produces is an input to `/jig:do-item`, to the repository's own
> planning skill, or to whatever work follows — never a licence to start
> editing the code the decision is about.

Jig maintains this procedure and ships it in the `jig` plugin.
Each repository supplies its own values in `.config/jig.yaml`
(see [Consumer configuration](#consumer-configuration)); every value has a
default, so the skill works in a repository that has configured nothing.

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string.

Run every command from the root of the repository the dilemma is about. Never
`cd` into the skill directory: the scripts find the repository and its
configuration from the working directory, or from `JIG_CONSUMER_ROOT`
when it is set.

### Consumer configuration

The skill reads these fields from `.config/jig.yaml` at run
time. Every one is optional.

| Field | What it sets | When absent |
|-------|--------------|-------------|
| `adr.directory` | The directory holding the ADRs, named `ADR-NNNN-<slug>.md` (Jig module M5, ADR practice); shared with `/jig:adr` | Detected as `/jig:adr` does (`docs/adr`, `doc/adr`, `docs/decisions`, …), else `docs/adr` |
| `decide.policy_files` | Instruction files whose `##` sections are standing policy | `[AGENTS.md]` |
| `decide.rules_directory` | A directory of conditional rule files, one rule per `.md` file | `.claude/rules` |
| `decide.glossary_file` | The canonical vocabulary, as `**Term**:` lines each followed by an `_Avoid_:` line of aliases | `CONTEXT.md` |
| `decide.architect_agent` | The subagent that rules in phase 3; a name your agent tool does not know (for example a Claude Code agent under Codex) falls back to the default | A fresh general-purpose subagent, briefed with the [architect mandate](#the-architect-mandate) |
| `decide.escalation_labels` | Labels added to an issue alongside `hitl` and its `hitl:<stakeholder>` facets when a call is escalated (for example the label that routes it to an architect) | None |
| `issue_tracker.*` | The issue tracker, as `/jig:do-item` reads it (adapter, team key, `file_command`, and the `hitl` label in `labels.hitl`) | No tracker: outcomes land in the reply only |

### Tracker operations

Reads of an issue and posted comments go through the tracker scripts of
`/jig:do-item`, whose adapter `issue_tracker.adapter` selects. A
harness with a native integration for the same tracker may use it instead; the
Linear forms are given as the adapter example.

| Operation | Script form | Adapter example: Linear (MCP) |
|-----------|-------------|-------------------------------|
| Get issue | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/get_issue.ts" <KEY>` | `mcp__linear__get_issue` |
| List comments | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/list_comments.ts" <KEY>` | `mcp__linear__list_comments` |
| Post comment | `bun "${CLAUDE_SKILL_DIR}/../do-item/scripts/tracker.ts" comment <KEY> < body.md` | `mcp__linear__save_comment` |
| Search open issues | — | `mcp__linear__list_issues` with a query |
| Add labels | — | `mcp__linear__save_issue` with `addLabels` |
| File a new issue | The consumer's `issue_tracker.file_command` | — |
| Attach a sheet | — | see [`references/decision-sheet.md`](references/decision-sheet.md#post-the-sheet) |

Issue keys in this document look like `ENG-123`.

## The phases

| Phase | What happens | Runs on |
|---|---|---|
| **1 · Resolve** | Search the precedent corpus. If it is already decided, stop and cite it | `scripts/resolve-precedent.ts` — mechanical, no model |
| **2 · Frame** | State the real options, the trade-offs, and the repository facts each rests on | This session |
| **3 · Rule** | One call, or an explicit escalation | The architect agent (a second, adversarial pass when material) |
| **4 · Route** | Put the outcome somewhere durable, or deliberately nowhere | This session |

**Two inputs.** `/decide <the dilemma, in words>` starts from a question.
`/decide <issue-key>` starts from an **existing issue** that already holds the
question but has no framed options — for example a decision register entry
that has a recommendation and a list of required outputs, but nothing to
compare. In that mode, fetch the issue and its comments (see
[Tracker operations](#tracker-operations)), take the question from them, and
run phases 1–3 as usual. Phase 4 then lands every outcome **on that issue**
and creates no new one (see its routing table).

Never skip phase 1. Spending an expensive reasoning pass re-deriving a settled
answer is waste, and worse, it can produce a confident recommendation that
contradicts a standing ADR. That is a measured failure class, not a
hypothetical one: in one review-learnings window, five rejected findings were
settled policy being re-litigated.

---

## Phase 1 — Resolve against precedent

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/resolve-precedent.ts" "<the dilemma, in words>"
# --json for a machine-readable report, --top N for more candidates
```

Pass the question in the user's own words plus any domain terms you already
know are involved. The script searches the ADRs, the `##` sections of the
policy files, the conditional rules, and the canonical vocabulary (each where
[the configuration](#consumer-configuration) says), and returns ranked
candidates with `file:line` evidence.

**Then read the candidates.** The score measures term overlap and nothing
else. A high score means "look here", never "this settles it" — the script
says so in its own output and it means it.

Also run the **roadmap read** the script deliberately does not do: search the
issue tracker for an open epic or issue that already owns this question. A
decision that contradicts work already in flight is worse than no decision.
The script stays repository-local so it is hermetic and testable; the roadmap
is your job.

**Check `report.incompleteSources` before applying any of the outcomes
below.** A non-empty list means the search covered only a subset of the corpus
(missing ADRs, policy, rules, or the glossary): `--repo-root` or a configured
path points at the wrong place, or the repository simply keeps no such
source. The search still ran and its verdict is real for what it actually
covered, but no verdict from it is actionable as-is: not `already-decided` (an
unseen policy or rule could supersede or conflict with the candidate you're
about to cite), and not `no-precedent` as zero-hit evidence (the renderer
itself refuses that framing — see its `INCOMPLETE` branch). Fix `--repo-root`
or the configuration and re-run phase 1 before treating any outcome below as
settled. When a source is absent because the repository has none (no rules
directory, no glossary), say so in the record instead: "the repository keeps
no conditional rules" is a fact, an unsearched directory is not.
`precedent-candidates` is the one partial exception: it never claimed
completeness to begin with, so carrying a degraded-corpus candidate into
phase 2 as input (never as the whole answer) is still fine.

Ways phase 1 can end:

- **`already-decided`** — a candidate genuinely answers the question. Say so,
  cite it `file:line`, and stop. There is no phase 2, no phase 3, and nothing
  to record: the decision already exists. In existing-issue mode
  (`/decide <issue-key>`), post the citation as a comment on that issue before
  stopping, so the issue records the settled answer. If the precedent is
  *nearly* right but not quite, that is not `already-decided` — carry it into
  phase 2 as the strongest input.
- **`precedent-candidates` that do not settle it** — continue to phase 2,
  carrying what you found. Say explicitly which candidates you read and
  dismissed, and why; a reader who cannot see that you checked will check
  again.
- **`no-precedent`** — continue to phase 2, and keep the report's corpus
  counts, **unless** `incompleteSources` is non-empty (see above), in which case
  stop and fix the search instead. "I searched N ADRs, M policy sections and
  K rules for these terms and found nothing" is citable evidence. "Nothing
  exists" is not.
- **`no-searchable-terms`** — the query tokenized to nothing (all stopwords, or
  every word below the minimum length), so no term ever reached the corpus.
  This is NOT `no-precedent`: nothing was searched, so there is no zero-hit
  evidence to carry forward. Do not proceed to phase 2 on it — rephrase the
  question with concrete, specific terms and rerun phase 1.

If the script raises a corpus error it has verified nothing — fix the invocation
rather than reading the error as an absence of precedent.

**Vocabulary.** If the report flags an **_Avoid_** alias, switch to the
canonical term before framing anything. Deciding in the wrong vocabulary
produces a decision nobody can find later.

---

## Phase 2 — Frame

Produce, briefly:

1. **The question**, restated in canonical vocabulary and narrowed to what is
   actually contested. Most "dilemmas" contain one contested clause and three
   settled ones; separating them is most of the work.
2. **The live options** — two or three, each a real candidate. An option nobody
   would take is padding, and it makes the recommendation look better than it
   is.
3. **For each option: what would have to be true for it to win.** This is the
   part a later reader needs, because it is what changes.
4. **The repository facts each option rests on, verified.** Every
   load-bearing "X exists" / "Y is missing" claim gets a `file:line` hit or an
   explicit zero-hit search. Never memory. This is the
   [architect mandate](#the-architect-mandate) and it applies from the moment
   framing starts.
5. **Delivery cost, named rather than folded into "ops"** — does any option
   add a manual step to a promotion, to an environment's end-to-end or sanity
   run, or to a restore or rollback path? Treat that as a first-class cost in
   every environment, production and pre-production alike: an option carrying
   one has to say why the step cannot be a command a workflow runs. A framing
   that leaves this cost out gets redone once a reviewer asks for it.
6. **Defects that no option fixes.** Framing reads the code, and it finds
   bugs: in one register of five decisions, framing surfaced six. A fact that
   is wrong under **every** option is not an input to the call. It is a bug.
   Search the tracker for an existing issue first (two of those six were
   already tracked). If none exists, file one (`issue_tracker.file_command`),
   and cite it in the framing instead of carrying the defect as a trade-off.
7. **Which sensitivity flags fire** — `has-migration` (a database
   migration), `api-change` (a published contract), `dpa-relevant` (personal
   data), `manual-ops` (a manual operational step) — because that decides who
   rules in phase 3. When the repository keeps a change-area catalog
   (Jig module M3; `drive.change_areas_catalog`) and a file list
   exists, resolve the flags from the catalog, not by eye.

---

## Phase 3 — Rule

**Who rules is mechanical, not a matter of confidence.** Work the ladder top
to bottom and take the first row that matches:

| If | Verdict | Who |
|---|---|---|
| Phase 1 settled it | `already-decided` | Nobody — cite it |
| Evidence is insufficient to choose, and gathering it is real work | `underdetermined` | This session names the missing evidence |
| Any sensitivity flag fires, **or** the call belongs to an `hitl:<stakeholder>` category (product, technical, tactical, legal, compliance, commercial) | `escalated` | A human, with the architect's pick marked **(Recommended)** |
| The choice is reversible inside one pull request, with no persisted-data and no published-contract consequence | `decided` | The architect agent may take it |
| Anything else | `escalated` | A human |

`hitl` marks a human-in-the-loop decision; `hitl:<stakeholder>` names whose
call it is (the label conventions `/jig:do-item` reads). A repository
that names the label differently sets it in `issue_tracker.labels.hitl`; read
`hitl` throughout as that label.

The last row is the important one: **the ladder fails closed.** A dilemma that
does not clearly fit `decided` is escalated, not decided confidently.

Why reversibility rather than importance: a choice that one pull request can
unwind is genuinely cheap to reverse, and exactly that class is safe for an
agent to take. Where the repository defers backward compatibility (for
example before its first release, as its policy says), that class is large. A
choice that writes a migration, changes a published contract, or touches
personal data is not in it, however obvious the answer looks.

**Delegate the ruling to the architect agent** (`decide.architect_agent`, or
a fresh general-purpose subagent briefed with the mandate below when that
field is unset or names an agent this tool does not have). Hand it the
phase-2 framing, the phase-1 report, and the sensitivity flags. The agent's
own definition decides its model; do not restate a model tier in the prompt.

#### The architect mandate

Whichever agent rules carries this standing mandate, stated in its brief when
the agent's own definition does not already carry it:

- **Verify every load-bearing claim against the code before endorsing it.**
  Each "X exists" / "Y is missing" claim gets a real `file:line` hit or a
  zero-hit search, never a memory-based pass. Plans routinely assert phantom
  tables and "already exists" primitives with full confidence; the architect
  is the skeptic in the loop.
- **Stress-test the risky parts**, not only the happy path.
- **Trust nothing another agent asserts without evidence**, including the
  first pass below.

**Run a second, adversarial pass** — a *fresh-context* architect agent given
the first pass's output and asked to break it — whenever the verdict is
`escalated`, and whenever the decision is material: it changes a schema, a
contract, a security boundary, a vendor, or it is expensive to reverse. The
escalated case is measured, not cautious: on one register of five decisions
the second pass broke between two and four recommendations in every one, and
twice reversed a first-pass recommendation that rested on a misread fact. For
a small reversible `decided` call, one pass is enough; say which you ran.

**A real disagreement between the two passes survives to the human.** Do not
average them into a confident recommendation. Two competent passes disagreeing
*is* the finding.

---

## Phase 4 — Route the outcome

| Verdict | Lands as |
|---|---|
| `already-decided` | Nothing new. A citation in the reply, and a comment on the live issue if one is open. In existing-issue mode, that comment is the whole outcome: post the citation on the given issue |
| `decided` | A **decision note** comment on the live issue (default). An ADR **only** if it clears the bar below |
| `escalated` | An issue carrying `hitl` + `hitl:<stakeholder>` (+ any `decide.escalation_labels`), its body in the [decision record](references/decision-record.md) format — plus a decision sheet above the threshold below |
| `human-decided` | A follow-up **decision note** comment on that same `hitl` issue, folding the human's ruling (and the reasoning behind it) back onto it — not a new issue. If the issue carries a decision sheet, regenerate it so the call shows as decided |
| `underdetermined` | A spike issue naming the missing evidence and what would settle it |

With no issue tracker configured, every outcome lands in the reply, and an
issue the table asks for is a draft the user files.

**Existing-issue mode (`/decide <issue-key>`) creates no issue.** Every verdict
lands as a comment on the issue it was given: `decided` and `escalated` as the
record, `underdetermined` as the missing evidence (the issue already tracks
the open question, so no spike is filed). For `escalated`, add `hitl`, the
`hitl:<stakeholder>` facets and any `decide.escalation_labels` to that issue
when they are missing.

**Decision sheet — generated at escalation time above the threshold.** An
`escalated` call gets an HTML decision sheet when it carries two or
more `hitl:<stakeholder>` facets, or a call with three or more options, or
when a human asks. Below that, the text is enough and no sheet is made. The
sheet has two layouts: `document` (the default, one page set as a report) and
`compact` (a drawing sheet, one page per call). Use `document` unless the
author asks for `compact`.
`bun "${CLAUDE_SKILL_DIR}/scripts/decision-sheet/decision-sheet.ts" trigger`
applies the rule. Above the threshold, phase 4 does not wait for a human to
ask for the trade-offs: it writes the decision source, renders the sheet and
its short comment from it, attaches the sheet to the issue and posts the
comment, together with the escalation. A regenerated sheet keeps the layout of
the sheet it replaces. The source format, the layouts, the render and
freshness check, the upload procedure and the regeneration after a ruling are
in [`references/decision-sheet.md`](references/decision-sheet.md).

The record format — the fields a ruling must carry, and why each one — is
[`references/decision-record.md`](references/decision-record.md). Read it
before writing the outcome.

**When an `escalated` verdict leaves open `hitl` calls below the sheet
threshold, and a human later asks to see the trade-offs on them**, elaborate per
[`references/human-call-elaboration.md`](references/human-call-elaboration.md)
— a distinct, conversational format from the record template above, for
getting the human to a decision rather than for recording one already made.

**Any text this skill writes to ask a human for a call** — an `escalated`
record, an elaboration, an `hitl` issue body — follows the
[writing rules for text that asks a human to decide](references/human-call-elaboration.md#writing-rules-for-text-that-asks-a-human-to-decide).
Run its advisory linter on the draft before you post it:

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/ste-lint/ste-lint.ts" draft.md
# or: cat draft.md | bun "${CLAUDE_SKILL_DIR}/scripts/ste-lint/ste-lint.ts" --json
```

**The ADR bar.** Mint an ADR only when the decision **constrains future code
beyond this change** — when a reviewer six months from now needs it to judge
unrelated work. Otherwise it is a decision note on the issue. A large corpus
makes phase 1 slower and less precise for every future invocation, so an ADR
per ruling is a direct tax on this skill's own best outcome. When an ADR is
warranted, hand off to `/jig:adr` rather than hand-rolling the file
and its `adr-rules.yaml` entry.

**Two disciplines that are easy to skip and expensive to miss:**

- **Future tense when the decision precedes the work.** Write "the scanners
  **will** parse with the real grammar", never "the scanners parse with the
  real grammar". A decision record is read as a description of the system; the
  present tense makes it false the moment it lands ahead of the
  implementation, and review catches exactly this.
- **Record the reversal condition and the evidence date.** Every premise
  expires. A decision that does not say what would reverse it cannot be
  honestly revisited, and a later session will either re-litigate it from
  scratch or defend it past its evidence.

Sensitivity flags carry obligations beyond this skill: a `dpa-relevant`
decision means the repository's records of personal-data processing change,
if it keeps them; `has-migration` and `api-change` pull in the repository's
mandatory review gates for those changes when the work lands. Name them in the
record so the implementing session inherits them.

---

## Triggering

- **Directly** — `/decide <the dilemma>`. The primary path.
- **On an existing decision issue** — `/decide <issue-key>`, for a `hitl` issue
  that states a question but frames no options yet. The outcome lands on that
  issue (phase 4).
- **From a skill that has reached a genuine fork** — a planning skill's
  human-decision step, `/jig:do-item` on an issue carrying
  `hitl:technical`, a `jig:review-arbiter` escalation that turns out to
  be an architectural question rather than a triage one.

**Trigger on an explicit decision ask, not on the presence of a fork in the
road.** Ordinary work contains dozens of small choices an implementing session
should simply make; routing them here would convert a useful gate into
ceremony, and ceremony gets skipped. If you are wondering whether a choice is
big enough for this skill, it almost certainly is not — the ones that belong
here announce themselves, usually because someone asked for a decision out
loud.

---

## What this skill will not do

- **Implement the decision.** Ruling and building are separate acts on purpose.
- **Decide a flagged change quietly.** The ladder's escalate rows are not
  advisory.
- **Manufacture an ADR** to make a ruling feel weightier.
- **Smooth over a disagreement** between passes, or between the ruling and an
  existing ADR. A contradiction with standing policy is a finding about the
  ruling, not a licence to overrule the policy in passing — changing a
  standing stance is its own decision, filed as one.
