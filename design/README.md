# Designs

Designs of [roadmap](../ROADMAP.md) items too large to describe in the
roadmap itself. A roadmap item says what will be built and when it is done;
its design here says how it works, so the pull requests that build it share
one plan.

A design describes work that is not built yet. When its roadmap item is
finished, the design leaves this folder in the same pull request: what it
describes moves to the skill or module that implements it (a skill's README,
a module's README and `mappings.md`), and the parts that were not built go
back to the roadmap or are dropped.

## Stages

Jig runs [M6](../modules/M6-feature-delivery-pipeline/README.md)'s feature
pipeline in a smaller form. Each stage hands one artifact to the next, with
one exception: research is done when a roadmap item or its design hangs on an
open question, and what it finds goes back into that item or design.

| M6 stage | Jig's artifact | Starts from |
| --- | --- | --- |
| Research spike | a research note in this folder, `<topic>-research.md`, when a roadmap item or its design hangs on an open question; it leaves when its item is finished | M6's [research-note template](../modules/M6-feature-delivery-pipeline/templates/research-note-template.md) |
| [PRD](../GLOSSARY.md) (product requirements document) | the roadmap item: what will be built, for whom, and when it is done | the items in [ROADMAP.md](../ROADMAP.md): a summary, what the item builds, and a "Done when" line |
| Architecture | the design in this folder | the skeleton in [§ Starting a design](#starting-a-design) |
| Design-prototype loop | for a browser interface, a design brief for an external design session, whose result may reopen the design | [`/jig:design-brief-builder`](../plugin/skills/design-brief-builder/SKILL.md) |
| Epic decomposition | the design's build order, one pull request per step | the design's Build order section |

Small items skip the design: their roadmap entry goes straight to pull
requests.

## Review before building

Every artifact is critiqued before the next stage builds on it, by a
reviewer with fresh context (one that did not write it: a new session, a
subagent, or the reviewers on a pull request) acting as an adversary would:
it looks for gaps, ambiguities, unstated assumptions and risks, and the
author settles every point in the text. The artifact is then
[de-scarred](../GLOSSARY.md): the findings live in the pull request, and the
artifact states only the result.

A roadmap item or a research note gets that critique from the review of its
pull request; a design brief gets it before it goes to the design session. A
design and its build order get a critique of their own before the first pull
request that builds them, and the design records it in a closing `## Review`
section: the date, the commit reviewed, and who reviewed it. A design without
that section has not been reviewed yet, and its next pull request starts
with the review.

## Current designs

| Design | Roadmap items |
|--------|---------------|
| [Session reflection](reflection.md) | 6, 7 |
| [The audit experience](audit-experience.md) | 8 |
| [Batching small issues](work-batch.md) | 13 |

## Starting a design

Copy this skeleton into `design/<topic>.md`, add a row to the table above,
and fill in each section; drop a section that has nothing to say.

```markdown
# <Topic>: design

**What problem this solves.** <What goes wrong today, and for whom, in plain
language. What it looks like with this built.>

This is the design of [ROADMAP.md](../ROADMAP.md) item <n>. <What is built
so far, if anything, and where it is documented.>

## How it works

<The mechanism, one section per part. Name the files, commands and
configuration it adds.>

## Build order

<The pull requests that build it, in order, each one shippable alone.>

## Left out

<What this design deliberately does not do, and why.>
```
