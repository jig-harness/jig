---
# PRD frontmatter. `status` and `reviewed` are what the M6 gates read; the
# fuller docs schema (type, lifecycle, owner, freshness) is M4's concern.
title: "<feature name> — product requirements"
type: prd
status: draft            # draft → accepted (set to accepted only after review)
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
# reviewed: "<reviewer>, <YYYY-MM-DD>, <#issue / PR / commit>"   # required at status: accepted
---

# Product requirements: <feature name>

> TEMPLATE — a PRD says **what** the feature does for users and **why**. Keep
> **how** (stack, storage, frameworks) out; that is the architecture doc's job.
> The `##` sections below are required — the required-sections gate checks they
> are present. Delete these template notes as you fill it in.

## Problem statement

What is true today, who it hurts, and what "solved" looks like. State the
outcome, not a solution.

- **Current situation:** <what people do now and where it breaks down>
- **Desired outcome:** <what becomes possible / easy once this ships>
- **Why now:** <the value or pressure that makes this worth doing>

## Users and personas

Who this is for. For each persona: their goal, their current pain, and how they
will judge success.

### <persona name / role>

- **Goal:** <what they are trying to achieve>
- **Pain today:** <the friction this feature removes>
- **Success looks like:** <their words for "this worked">

## Requirements

Numbered so the architecture and tests can reference them. Each requirement is a
user-facing capability with testable acceptance criteria — not an implementation
note.

### FR-1: <requirement title>

- **Priority:** <must have | should have | nice to have>
- **User story:** As a <persona>, I want to <action> so that <benefit>.
- **Acceptance criteria:**
  - [ ] <specific, testable outcome>
  - [ ] <edge case / error state and how it behaves>

### FR-2: <requirement title>

- **Priority:** <must have | should have | nice to have>
- **User story:** As a <persona>, I want to <action> so that <benefit>.
- **Acceptance criteria:**
  - [ ] <specific, testable outcome>

### Non-functional requirements

Qualities the feature must have (responsiveness, accessibility, reliability),
each stated as an observable target rather than a stack choice.

- **NFR-1:** <e.g. a saved view opens fast enough to feel instant>
- **NFR-2:** <e.g. every interaction is reachable by keyboard>

## Success metrics

How you will know it worked, in numbers, after it ships. Each metric names a
target and how it is measured. Vague metrics ("users are happier") are a review
finding.

| Metric | Target | How measured |
|--------|--------|--------------|
| <adoption> | <e.g. 50% of weekly-active users use it in month one> | <event / query> |
| <effectiveness> | <e.g. task completion rises from X to Y> | <event / query> |
| <quality> | <e.g. error rate on the new flow < Z%> | <event / query> |

## Scope

Draw the line explicitly, so the epic stage decomposes the right thing.

- **In (this iteration):** <the capabilities included>
- **Out (explicitly excluded):** <what has been discussed and ruled out for now>
- **Later:** <deferred to a future phase, with a one-line why>

## Open questions

Unknowns that could change the shape of the feature. A question that blocks a
decision is a candidate for a research spike (see
`research-note-template.md`); an answer that settles a decision becomes an ADR.

- <question> — <who / what resolves it>

## Review

<!-- Filled in at acceptance. A terse record that an adversarial, fresh-context
     review happened — reviewer + date/ref — then de-scar the body. Remove this
     note. Alternatively record the review in the `reviewed:` frontmatter key. -->

## Version history

| Version | Date | Change |
|---------|------|--------|
| 0.1 | <YYYY-MM-DD> | Initial draft |
