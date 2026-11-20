---
title: "ADR-0027: Jig ships a reference reviewer for the reviewer-evidence contract"
type: adr
status: draft
description: "Jig depends on drive-pr's reviewer-evidence contract, ships a reference reviewer that implements it from its own repository, and accepts any reviewer that meets the contract"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-20
owner: maintainers
decision_date: 2026-11-20
supersedes: ~
superseded_by: ~
tags: [adr, review, drive-pr, reviewer]
---

# ADR-0027: Jig ships a reference reviewer for the reviewer-evidence contract

**Status:** Draft · **Date:** 2026-11-20 · **Deciders:** Jig's maintainers

## Context

[`drive-pr`](../../plugin/skills/drive-pr/README.md) drives a pull request
through review rounds until it converges. It finds out that an AI reviewer
has reviewed the head commit from the reviewer's own evidence, which is the
*reviewer-evidence contract* ([GLOSSARY.md](../../GLOSSARY.md)): a check run
whose name matches `review.reviewer_check_pattern` (from the configured
reviewer app, when one is named), plus either a sticky summary comment that
the reviewer's own bot account posts, that carries `review.sticky_marker` and
that stamps the reviewed commit as an HTML comment under
`review.reviewed_sha_marker` (and may carry a skip notice), or, in
`review_object` mode, the commit that the newest review object names, or a
successful or neutral check run on the head when the reviewer posts nothing
for a push with no new findings. [drive-pr's README](../../plugin/skills/drive-pr/README.md)
is the complete definition; the shorter statements elsewhere abbreviate it.

Jig writes none of that evidence. The [`review`](../../plugin/skills/review/SKILL.md)
skill checks a change before it is pushed and never posts. The dispatcher has
no review stage. [M7](../../modules/M7-pr-lifecycle-review/README.md) left a
reviewer runtime out of the module, and drive-pr's README says Jig ships no
reviewer that implements the protocol. A team with no AI
reviewer of its own has nothing to drive against, and a drive on such a
repository converges on CI and threads alone.

## Decision

**Jig depends on the contract, not on a reviewer.** The reviewer-evidence
contract is the interface. Any reviewer that produces its completion
evidence and posts its findings as review threads works with the drive.
Findings placed only in a summary or review body are read for a reviewer with
a built-in body format and no other. The drive reads no reviewer by name
beyond the profiles it already holds.

**Jig ships a reference reviewer that implements the contract.** It reverses
M7's "A reviewer runtime" entry under "Left out by design". M7 keeps the
other entries and now names the reference reviewer and the contract instead.

**The reference reviewer lives in its own repository, never in the plugin.**
It is ai-review, to be published as `jig-harness/ai-review` under Apache-2.0,
as a reviewer with its own read-only tool loop that posts one updated summary
comment, inline comments and a check run. It runs in an adopter's CI or as a
service, not on every machine the plugin installs on, and it releases on its
own cadence. Its GitHub Action form comes first: it runs in the adopter's
CI, posts as `github-actions[bot]`, takes its model key from a repository
secret and calls an OpenAI-compatible or Anthropic endpoint the team
chooses. A service form that polls many repositories follows. Jig names the
repository as one implementation beside the others, as its writing rules
ask of a tool that Jig's tooling is bound to. The repository is planned and
not yet public, so every document says "planned" until it is.

**Until it is published, M7's mappings name the reviewers a team can add
today**, most with a model key it keeps as a secret and CodeRabbit as a hosted
service, and say what each meets of the contract. drive-pr already has a
built-in profile for CodeRabbit and gets none for the others until a consumer
validates one.

**How the audit scores a repository with no automated reviewer is not
decided here.** That stays with the audit's own change.

## Alternatives considered

- **Move the reviewer into Jig under "move, never copy".** Rejected: it would
  put a reviewer and its service into a plugin that every machine installs,
  and tie the reviewer's releases to the plugin's.
- **Keep Jig reviewer-free and document only the contract.** Rejected: a team
  with no reviewer of its own would have nothing to run, and the contract
  would have no implementation Jig tests against.
- **Bind drive-pr to one reviewer.** Rejected: the drive reads evidence, and
  a second implementation must work without changing the drive.
- **Name no implementation until the reviewer is public.** Rejected: an
  adopter today needs the interim reviewers and what each lacks, and the plan
  needs to say where the reference reviewer will come from.

## Consequences

### Benefits

- A team with no AI reviewer has a path to a drive that waits on a real
  review.
- The contract has a reference implementation, so a change to it is tested
  against something.
- A reviewer from any source works, so the contract stays the product.

### Costs

- Jig now owes the contract a reference implementation, kept in step in a
  second repository.
- The mappings name third-party reviewers whose behaviour changes without
  notice, so each row says what it meets and where to read more.
- The reviewer's measurement and publishing are work outside this
  repository, tracked by [plan item 60](../../design/plan.md).

## Implementation

This record is the first step of plan item 60: it changes documents only.
M7's README and mappings, the plan, the roadmap and the glossary carry the
decision. drive-pr's README and the [AI reviewers](../../plugin/EXTENDING.md#ai-reviewers)
section of the extending guide point at the reference reviewer in a later
change, once the repository is public. The reviewer's own work, its
configurable endpoints, its cost record and its measurement against its
Codex engine, happens in its own repository.

## Extraction (decisions-become-checks)

Not mechanically checkable as a text pattern, and the repository has no
decision-rules catalog. Review checks that no document presents the
reference reviewer as published before it is, and that the plugin holds no
reviewer runtime.
