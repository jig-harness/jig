# Follow-up arm: the glossary and the auditor

A merge into Jig owes what no gate settles: its terms of art are explained,
and the next audit scores the practice it changed. Paths are from the
repository root.

Record one verdict for the arm with the follow-up's `record` command:
`owed` with each item filed, `not-owed` naming both answers (the terms the
merge introduced, all in the glossary, or that it introduced none; the
criteria it targeted, or that its description says the audit did not
change), `unread` when the pull request's description could not be read.

## 1. The glossary

A term of art the merge introduced (a name for a practice, a mechanism or a
role that a reader unfamiliar with it would stop at) is in `GLOSSARY.md`,
and its first use in each document links there (AGENTS.md, writing
conventions). The gates check acronyms only
(`scripts/check-glossary-coverage.ts`), so read the merge's added prose for
new terms: the diff of its Markdown files, and the descriptions of any skill
it added or changed. Each term missing from the glossary is owed.

## 2. The auditor

Every pull request says what it changed in the audit, or why nothing needed
to (CONTRIBUTING.md, keeping the auditor current). Read that statement in
the merged pull request's description:

- **No statement**: owed. File the re-evaluation the pull request skipped:
  does `plugin/skills/audit/config-schema.yaml` list each field the merge
  added, do the criteria and their probes still describe the practice, does
  `plugin/skills/audit/scripts/config-fit.ts` check what the change made checkable.
- **The merge targeted criteria** (it built or changed a practice an
  existing criterion scores): the record `.config/jig-audit.yaml` keeps the
  scores of the commit it audited, so the next audit (`/jig:audit`) is what
  scores the change. Record it owed with the criteria named, as work for the
  next audit, rather than running the audit here. Where an open item
  already carries that audit, name it as the arm's item; otherwise file one.
- **The statement says nothing changed, and the diff agrees**: not owed for
  this part.
- **The statement says nothing changed, but the diff disagrees** (it adds a
  configuration field, changes a criterion's practice or a probe), **or it
  describes schema or probe changes without naming a targeted criterion**:
  the evaluation is incomplete or contradicted, so record this part owed and
  file the correction, naming what the diff changed and which of the
  re-evaluation questions above the statement leaves unanswered.

## What to carry out

File one item for the glossary entries owed, or add them to the item the
website arm files for the same merge when it files one. The follow-up opens
no pull request of its own.

## Before the merge

In a preview, check both against the branch: the terms its diff introduces
that the glossary lacks, and whether its description says what changed in
the audit. Record what is missing as what the merge will owe, so the pull
request can fix it before the merge.
