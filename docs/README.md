# Jig's own documents

How the documents in this repository are kept: what kind each one is, how
each kind changes, and which one is right when two disagree. Without this,
the same fact drifts apart in several places and nobody can say which copy
to trust. This is Jig's own form of
[M4](../modules/M4-docs-governance/README.md).

This folder holds:

- [adr/](adr/): Jig's standing decisions, as numbered decision records.
- [dispositions.md](dispositions.md): how to lean when several approaches are
  viable and no rule decides, each default with the condition that changes it.

## Kinds of document

Jig's own documents carry no frontmatter, except decision records, which
carry M5's frontmatter, and skill and agent definitions (the plugin's, and
Jig's own skills in `.claude/skills/`), which carry the metadata the agent
runtimes read, and [change notes](../changes/README.md), whose `release`
front matter the release step reads. Copyable `templates/`, test
fixtures and vendored `seeds/` are not Jig's own documents: they keep the
frontmatter their purpose needs. Where a document lives says what kind it is
and how it changes. An `AGENTS.md` file is an instruction wherever it lives;
any other document in a doctrine or plans directory has that directory's
kind, its README included.

| Kind | Where | How it changes |
| --- | --- | --- |
| Decisions | [adr/](adr/) | amended or superseded, never rewritten |
| Instructions | the `AGENTS.md` files, and [CONTRIBUTING.md](../CONTRIBUTING.md) they point to | in the pull request that changes the rule |
| Terms | [GLOSSARY.md](../GLOSSARY.md) | a term enters in the commit that first uses it |
| Reference | every document no other row places: `SKILL.md`, [CONFIGURATION.md](../plugin/CONFIGURATION.md), the skills' references, and the READMEs outside the doctrine and plans directories | describes what exists now; changes with what it describes |
| Doctrine | [modules/](../modules/README.md), [principles/](../principles/README.md), [profiles/](../profiles/README.md), [adoption/](../adoption/brownfield.md), [FACTORY.md](../FACTORY.md), [FEATURES.md](../FEATURES.md), [dispositions.md](dispositions.md) | rewritten to stay current, never appended to |
| Plans | [ROADMAP.md](../ROADMAP.md), [design/](../design/README.md) | open work only; an item and its design leave when it is finished |
| History | [CHANGELOG.md](../CHANGELOG.md) (written from [change notes](../changes/README.md) by the release step), the audit's dated [calibration runs](../plugin/skills/audit/calibration/), git, pull requests | appended to; never edited to state what is true now |

`AGENTS.md` stays short: it holds what every session must know (the rules
no change may break, and where to read next) and points to the document
that holds the detail. New practice detail goes into the document of its
kind, and `AGENTS.md` links to it only when every session needs to know it
exists.

## Which document wins

When two documents disagree, the one higher in this order wins, and the lower
one is corrected when the conflict is found: decisions; instructions, the
nearest `AGENTS.md` first; terms; reference, a `SKILL.md` before its README;
doctrine; plans, the roadmap before a design; history. Where the order does
not decide, as between two documents of one kind it does not rank, a person
does, and the answer is written into the document that was wrong.

What runs (code, configuration, gates) settles what Jig does today: a
document that describes it differently is corrected. It does not settle what
Jig should do: code that breaks a decision or an instruction is what gets
fixed, never a reason to loosen the rule. A change is reviewed against the
rules on the base branch, not the rules it brings with it
([review](../plugin/skills/review/SKILL.md#policy-comes-from-the-base-branch-not-the-change-under-review)).

## Decision records

A standing decision (a toolchain, what ships, who merges) is recorded as a
numbered [ADR](../GLOSSARY.md) in [adr/](adr/), made with `/jig:adr` from
[M5](../modules/M5-adr-practice/README.md)'s template. An approved record is
never rewritten: it changes by a dated entry under `## Amendments` (bump
`version`, set `status: amended`, keep `decision_date`), or a new record
supersedes it, setting `supersedes` while the old one gets `superseded_by`
and `status: deprecated`. Before deciding something already recorded, read
the record; `/jig:decide` looks there first.

## Designs

A new design starts from the skeleton in
[design/README.md](../design/README.md#starting-a-design), which also maps
Jig's delivery stages and requires a review before a design is built.
