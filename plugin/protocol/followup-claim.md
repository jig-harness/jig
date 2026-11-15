# The follow-up claim and its result

Version 1 · stable

When a pull request merges, its follow-up settles what the merge still
owes, by running the repository's follow-up command on it once. The
[follow-up marker](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
claims that one follow-up, so that one run takes it and the later run stops
before it acts, and says how it ended. The claim settles who won once both
markers are visible on the forge: two runs whose listings lag can each read
themselves as the winner and both act, so a follow-up command's effect outside
the pull request must be safe to repeat. A [dispatcher](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)'s
[tick](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) posts one
before it starts the follow-up's session; a follow-up a person runs posts one
through `jig dispatch marker claim`. The dispatcher reads the markers to
know which merges are followed up, how each ended and what to tell a
person; a second host dispatching the same repository reads them as its
[shared records](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md);
and a repository's own follow-up command reads them through
`jig dispatch marker check` before each act outside the pull request.

The marker is a comment on the merged pull request that opens with
`<!-- jig-dispatch-followup -->` on a line of its own, holds its record in
the record envelope's marker form in the second marker, and ends with a line
a person reads. [The hidden comment markers' chapter](comment-markers.md#the-envelope-and-the-markers-form)
gives the envelope and the form; the record's own fields are below.

It is a [forge claim](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
and is read by the claims' rule. A marker counts only from a trusted author:
the reader's own forge login, or an author the forge vouches for as an
owner, member or collaborator of the repository. Of two trusted markers,
the earlier comment wins, and the later run stops before it acts
(`jig dispatch marker` exits `3`). A pull request has one follow-up, so a
trusted marker whose record does not read still claims it, and holds
against every later one until a person settles it, by marking it done or
deleting it. A marker whose outcome is not one listed here for its run, or
whose version is newer than the one listed, does not read, and so holds the
same way: the reader starts no follow-up over it. Only the host that posted
a tick's marker writes its outcome.

Two earlier forms still read: version 1 of the record, whose key was the
pull request's number, and the line form written before the envelope, whose
second line is `jig dispatch follow-up · record: <id>` for a tick or
`jig dispatch follow-up · run: manual · outcome: running` (or `done`) for a
person's run. The dispatcher also keeps each tick's follow-up outcome in its
own database (`dispatch-followup-outcome` in [RECORDS.md](../RECORDS.md)),
with the values a tick's marker carries, so the outcome outlives the launch
record.

How a follow-up command claims, checks and ends its marker with
`jig dispatch marker`: [the plugin's README](../README.md), under its
follow-ups. The runs and their outcomes, for a program in any language:
[data/followup-claim.json](data/followup-claim.json), whose `field` entries
also give each payload field's type and the runs whose markers carry it;
the JSON Schemas below publish the claim and result forms those records use.

## The record

<!-- protocol:generated source=plugin/shared/records/registry.ts#RECORD_KINDS -->

| Kind | Medium | Markers | Version | Key | Meaning |
| --- | --- | --- | --- | --- | --- |
| `dispatch-followup` | forge | `jig-dispatch-followup`, `jig-dispatch-followup-data` | 2 | `^(?:followup\|[1-9]\d*)$` | The claim on a merged pull request's one follow-up: which run took it, a dispatcher's tick or a person's, and once it ended, its outcome. A follow-up posts or reads it before it acts, and stops when an earlier trusted marker holds the follow-up. |

<!-- /protocol:generated -->

## The runs

<!-- protocol:generated source=plugin/shared/records/followup-values.ts#FOLLOWUP_RUNS -->

| Run | Meaning |
| --- | --- |
| `tick` | A dispatcher's tick took the follow-up: its marker names the launch record of the session the tick started and the host that started it, and that host writes the follow-up's outcome onto the marker once the launch record ends. |
| `manual` | A person ran the follow-up, and its run posted the marker through `jig dispatch marker claim`: the run writes its own outcome onto it (`jig dispatch marker done`). |

<!-- /protocol:generated -->

## The outcomes

A tick's marker carries no outcome while its follow-up runs, and until its
host writes the end.

<!-- protocol:generated source=plugin/shared/records/followup-values.ts#FOLLOWUP_OUTCOMES -->

| Outcome | Run | Meaning |
| --- | --- | --- |
| `done` | `tick` | The follow-up's session recorded its result as done (`jig dispatch result`): the follow-up is finished, and nothing starts it again. |
| `failed` | `tick` | The follow-up's session ended without recording done, or its launch died and is not retried: a person acts, and the marker keeps holding the follow-up against every later one until a person marks it done or deletes it, or the dispatcher's recovery releases it once, as for a rate-limit wait or a routine that failed. |
| `running` | `manual` | A person's run claimed the follow-up and has not finished its last act. It holds the follow-up against every later run; a run that failed leaves it so (`jig dispatch marker failed`) until a person marks it done or deletes it, or the dispatcher releases a stale one once. |
| `done` | `manual` | A person's run finished its last act (`jig dispatch marker done`): the follow-up is finished. |

<!-- /protocol:generated -->

## The record's fields

Beside the envelope's, Jig's writers write these fields into a marker's
record, and no other. "Always" and "sometimes" say whether a run's marker
carries a field on every marker or on some; "never" that it carries none.

<!-- protocol:generated source=plugin/shared/records/followup-values.ts#FOLLOWUP_FIELDS -->

| Field | Type | A `tick` marker | A `manual` marker | Meaning |
| --- | --- | --- | --- | --- |
| `pr` | integer | always | always | The number of the pull request the marker is on; a marker whose record names another pull request does not read. |
| `run` | string | always | always | Which run took the follow-up: one of the runs listed above. |
| `record` | string | always | never | The launch record of the session the tick started, in the dispatcher's form `<yyyymmdd>T<hhmmss>Z-<8 hex>`. |
| `host` | string | sometimes | never | The host whose tick took the follow-up, as a digest of its dispatcher's database instance: a public comment names no machine, and that host recognises its own marker. A marker posted before markers named their host carries none until the host that ends it writes its own. |
| `owner` | boolean | sometimes | never | Whether the host that took the follow-up owns the repository's board, notifications and history rows; absent where that host does not say. |
| `outcome` | string | sometimes | always | Where the follow-up stands: one of the outcomes listed above for the marker's run. A tick's marker carries none until its host writes the end. |
| `endedAt` | string | sometimes | never | When the follow-up's launch ended, as an ISO 8601 time, written by its host with the outcome. |
| `by` | string | sometimes | never | Who wrote the follow-up run's closing report (agent, driver, wrapper, steward or person), or none when it left none, written by its host with the outcome. The report's own text stays on that host. |
| `cause` | string | sometimes | never | Why the follow-up run fell short, from the closing report's closed list of causes, written by its host with the outcome when the report named one. |

<!-- /protocol:generated -->

## JSON Schemas

The [claim schema](schemas/followup-claim.json) describes the enveloped JSON
record, including version 1 envelopes. The
[result schema](schemas/followup-result.json) additionally requires a final
outcome. Earlier plain-text markers retain their textual grammar.
Version 1 identifies its pull request by its envelope key and ignores any
`pr` field; version 2 requires `pr` and uses the key `followup`.
