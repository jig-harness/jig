# Hidden comment markers on the forge and the tracker

Version 1 · stable

Jig's parts leave records for each other where everyone who can read the
repository reads them: comments and the pull request's body on the
[forge](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (the
service that hosts the repository, GitHub today), and comments and
descriptions on the tracker. A hidden marker is an HTML comment,
`<!-- name … -->`, which a rendered page does not show: it says which record
a comment, or a part of a body, is, and some markers carry the record's data
as well. A drive, the
[dispatcher](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), the
review and pickup skills and `jig send` write them; the same parts read them
back, and so may a dashboard, a board or a repository's own scripts. This
chapter lists the markers Jig writes or reads on the forge and the tracker,
with the record each marks and what that record means, except the kinds it
leaves to other chapters, which its last section names.

Each kind is registered in the
[records registry](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
under its name. A kind with a key carries the
[record envelope](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md):
its data is one JSON object inside a marker, the envelope's fields beside
the record's own. A reader checks the envelope against a strict form before
it reads anything else: the kind is registered, the version is a positive
integer no newer than the one this chapter lists for the kind, the key has
the kind's shape, the writer names a host, the time is a real date and
time, and a generation, where there is one, is a count. A record that fails
it does not read. A version newer than the one
listed was written by a newer release, and is refused rather than guessed
at. The rest of the record is data, never a command: no field of it makes
its reader run, fetch or follow what it names. A kind with no key has a form
of its own, which [RECORDS.md](../RECORDS.md) gives beside each record's
writer and what keeps two writers apart.

A reader counts most kinds' markers only from a trusted author: the
reader's own forge login, or an author the forge vouches for as an owner,
member or collaborator of the repository. A marker anyone else wrote is
ignored. A reply's last-line marker does not prove who wrote it, and the
markers of a kind another tool writes are as trustworthy as that tool.
[RECORDS.md](../RECORDS.md) says, for each kind, whose markers count. A hidden comment
whose marker neither this chapter lists nor belongs to a kind its last
section leaves out is not one of Jig's records, and Jig's readers ignore it.

A kind's version is part of this chapter's promise: a release whose writers
write a newer version of a listed kind raises this chapter's version.

The same values, for a program in any language:
[data/comment-markers.json](data/comment-markers.json).

## The kinds that carry markers

"Markers" gives how each marker's comment opens after `<!-- `; what follows
it, on the same line or the next, is the kind's own. "Written by" is `Jig`
for a kind Jig writes, and names the tool or the person that writes a kind
Jig only reads.

<!-- protocol:generated source=plugin/shared/records/registry.ts#RECORD_KINDS -->

| Kind | Medium | Markers | Version | Key | Written by | Meaning |
| --- | --- | --- | --- | --- | --- | --- |
| `drive-ledger` | forge | `drive-pr-ledger`, `drive-pr-ledger-data` | 2 | `^[1-9]\d*$` | Jig | The drive's resumable state, mirrored onto the pull request at each round boundary, park and takeover: who drives it, its round, what is parked and how the drive stands, so a drive started in another clone or on another machine resumes where the last one left off. Only a driver writes it; of two ledgers the earliest trusted comment is the ledger. |
| `summary-answer` | forge | `drive-pr-addressed` | 0 | — | Jig | The drive's answer to a review finding the reviewer could not anchor to a line of the diff, one marker per finding with its fingerprint. A finding whose marker a trusted author wrote counts as answered, and is not answered again. |
| `thread-reply` | forge | `triage-thread:leave-open`, `reply-to-thread:no-outcome`, `reply-to-thread:provisional` | 0 | — | Jig | A reply on a review thread. Its last-line marker says the thread was answered and is deliberately left unresolved, the reply asks a question and carries no outcome, or its outcome is provisional and a person may reverse it. A marker counts only as the reply's last line, and does not prove who wrote it. |
| `deferred-section` | forge | `jig-deferred`, `deferred-entry` | 0 | — | Jig | The findings a pull request deferred, one entry each in its body, which are filed as tracker issues once it merges or closes. A person's text outside the markers is never touched. |
| `drive-answer` | forge | `jig-send-answer` | 1 | `^answer:\S+$` | Jig | A person's answer to one parked question, written by `jig send`: the re-arm reads its `answer <key>:` line from a trusted author and hands the answer to the next pass. Each person's latest answer counts. |
| `ai-review-summary` | forge | `ai-code-review` | 0 | — | the repository's AI reviewer | The AI reviewer's summary comment, with the commit it reviewed and any notice that it skipped one, from which the drive learns whether the head was reviewed and what the review left open. The markers are the repository's configuration; the one listed is the default. |
| `ai-review-round` | forge | `ai-review-round`, `ai-review-backlog` | 0 | — | the repository's AI reviewer | The review round a reviewer's comment belongs to, and the findings the reviewer held out of its threads, which the drive counts as summary findings to answer. |
| `coderabbit-comment` | forge | `coderabbit-ai-generated:v1`, `coderabbit-skip-review-comment-follow-up` | 0 | — | CodeRabbit | A review bot's follow-up on an answered thread that carries no new finding (a confirmation after a push, or an acknowledgement of a reply), which the drive lets pass without an answer. |
| `coderabbit-review-body` | forge | `cr-comment:v` | 0 | — | CodeRabbit | A finding the reviewer put only in the body of its review, never in a thread, marked with its id, which the drive reads as a summary finding to answer. |
| `do-item-pr-association` | tracker | `do-item-pr` | 0 | — | the session following the do-item skill | Binds a tracker item to the exact pull request opened for it, where no issue-link line is required, so the item's parent roll-up can tell whether that pull request merged. A link in any other comment is no evidence. |
| `deferred-batch` | tracker | `defer-batch-key` | 0 | — | Jig | The issue that collects one pull request's deferred findings of one type, found by its key so that each finding is appended to it rather than filed alone; of two with one key the oldest wins. |
| `tracker-claim-marker` | tracker | `jig-claim`, `jig-claim-data`, `jig-claim-outcome` | 1 | `^claim$` | Jig | The token a claim posts on an item before it writes the item, naming the claim's attempt, its session, its branch and the claimant, so another tool sees which session holds the item, and of two hosts claiming it at once the earliest marker wins; beside it, each attempt records once how it ended (claimed, released or unresolved), and a marker whose attempt recorded released or unresolved holds nothing. |
| `tracker-related` | tracker | `jig:related`, `jig:related-superseded` | 0 | — | Jig | A link from one GitHub issue to another, written as a comment before GitHub had related links: read as a link until the migration converts it to GitHub's own and marks it superseded. |
| `tracker-attachment` | tracker | `jig:attachment` | 0 | — | Jig | A file attached to a GitHub issue, its text carried in the comment or a link to a hosted copy. A carried file whose text no longer has the size its marker records reads as changed, never as the file. |
| `tracker-blocked` | tracker | `jig:blocked` | 0 | — | Jig | That an item was moved to blocked because its pull request's drive stopped, naming the pull request, the stop and the state the item left, so one stop blocks the item once and the item returns only to that state. |
| `issue-fields-sweep` | tracker | `jig:issue-fields` | 0 | — | Jig | That the weekly sweep found an issue incomplete, naming the facets it lacks and the retired labels it carries: it moved the issue back to triage, or, where the repository keeps the sweep from moving issues, left it where it is. A run that stopped before the move finds the comment and moves the issue without posting again; where the sweep does not move issues, a later run passes over an issue that carries it. |
| `reflection-github-store` | tracker | `jig-reflection-change`, `jig-reflection-events` | 1 | — | Jig | The GitHub reflection store: an issue per change, and comments holding the change's events, read only from authors who can write to the repository. |
| `fleet-health-suspicion` | tracker | `fleet-health` | 0 | — | Jig | A suspicion the fleet-health sensor raised on an epic, of work that shows ceremony without progress: never a diagnosis, which only a person's comment on the epic makes. |
| `epic-acceptance-verdict` | tracker | `epic-acceptance-verdict` | 0 | — | a person accepting an epic | A person's verdict on an epic, `ACCEPT`, `ACCEPT-WITH-FOLLOWUPS` or `REJECT`, on the comment's last line. The fleet-health sensor counts an epic accepted when its newest verdict from a trusted author accepts it. |

<!-- /protocol:generated -->

## The envelope and the marker's form

A record that carries the envelope is written as one line of JSON between a
marker's opening line and its closing `-->`, the envelope's fields first.
Every `<` and `>` in the JSON is written as a Unicode escape, so nothing in a
record can close its comment early. [RECORDS.md](../RECORDS.md) gives the
rest of each kind's comment.

<!-- protocol:generated source=plugin/shared/records/envelope.ts#ENVELOPE_FIELDS,encodeMarker -->

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| `kind` | string | yes | The record's kind, as the records registry names it. A kind the reader's registry does not hold does not read. |
| `v` | integer | yes | The version of its kind's schema the record was written in, from 1. A version newer than the one the reader's release writes does not read. |
| `key` | string | yes | What the record is about, unique within its kind (on the forge and the tracker, within its repository), in the shape its kind declares. |
| `writer` | object | yes | Who wrote it: the forge login where the writer knows it, the host, and the boot, process id and start time of the writing process. On the forge and the tracker the host and the boot are digests, so a public comment names no machine. |
| `at` | string | yes | When it was written, as an ISO 8601 time. |
| `generation` | integer | no | For a record rewritten in place, or a claim on one round of something, a count: one past the highest the writer had read, or the round it claims. |

A `drive-answer` record, as the codec writes it in its marker:

```text
<!-- jig-send-answer
{"kind":"drive-answer","v":1,"key":"answer:pickup","writer":{"login":"example-login","host":"sha256:0123456789abcdef"},"at":"2026-01-01T00:00:00.000Z","pr":12}
-->
```

<!-- /protocol:generated -->

## Markers that are not records

A few hidden markers in Jig's code are not records: they mark files in a
repository, not comments on the forge or the tracker, and Jig never reads
one as a record.

<!-- protocol:generated source=plugin/shared/records/registry.ts#NOT_RECORDS -->

| Marker | Why it is not a record |
| --- | --- |
| `deferral-ok` | a waiver a person writes in a document, which the docs skill's deferral check reads |
| `Generated from` | the banner the change-areas skill writes at the top of a file it generates |
| `AUTO-GENERATED by generate-index.ts` | the banner the docs skill writes at the top of an index it generates |

<!-- /protocol:generated -->

## Kinds on the forge and the tracker this chapter does not list

Labels and a tracker item's own fields carry no hidden marker, so they are
not listed here. Nor are the forge claims, comments by which a host or a
driver claims one act on a pull request: the follow-up claim has a chapter
of its own, and so do [the takeover claim, the launch claim and the
merge-ready announcement](forge-claims.md). Of the trusted claims on one
key, the earliest comment wins.

<!-- protocol:generated source=plugin/shared/records/registry.ts#RECORD_KINDS -->

| Kind | Medium | Why it is not listed |
| --- | --- | --- |
| `drive-takeover-claim` | forge | a forge claim, which has a chapter of its own: [Forge claims: takeover, launch and merge-ready](forge-claims.md) |
| `dispatch-followup` | forge | the follow-up claim, which has a chapter of its own: [The follow-up claim and its result](followup-claim.md) |
| `dispatch-launch-claim` | forge | a forge claim, which has a chapter of its own: [Forge claims: takeover, launch and merge-ready](forge-claims.md) |
| `drive-merge-ready` | forge | a forge claim, which has a chapter of its own: [Forge claims: takeover, launch and merge-ready](forge-claims.md) |
| `scanner-finding-reply` | forge | its marker line is written by the session the resolve-review-comments skill instructs, not by Jig's code, so the registry holds no marker for it; [RECORDS.md](../RECORDS.md) gives its form |
| `ci-hold-label` | forge | a label on the pull request, not a hidden marker |
| `dispatch-command-label` | forge | a label on the pull request, not a hidden marker |
| `dispatch-state-label` | forge | a label on the pull request, not a hidden marker |
| `tracker-claim` | tracker | the item's own assignee and state on the tracker, not a hidden marker |
| `dispatch-pickup-assignment` | tracker | the item's own assignee and state on the tracker, not a hidden marker |
| `dispatch-pool-readiness` | tracker | the item's own state on the tracker, and who moved it there, not a hidden marker |
| `deferred-issue` | tracker | an issue whose description names the finding, not a hidden marker |
| `reflection-escalation` | tracker | an issue's label and a line of its description, not a hidden marker |

<!-- /protocol:generated -->

## JSON Schemas

The [record envelope](schemas/record-envelope.json) describes the shared
fields. JSON records also have their own schemas: the
[drive ledger](schemas/drive-ledger.json),
[sent answer](schemas/drive-answer.json),
[claim marker](schemas/tracker-claim-marker.json),
[claim outcome](schemas/tracker-claim-outcome.json),
[attachment header](schemas/tracker-attachment.json) and
[reflection event](schemas/reflection-record.json). Text marker grammars
remain the forms this chapter lists.
