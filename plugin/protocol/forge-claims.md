# Forge claims: takeover, launch and merge-ready

Version 1 · provisional, moved by [plan item 40](https://github.com/jig-harness/jig/issues/517), [plan item 49](https://github.com/jig-harness/jig/issues/865)

Several sessions and machines can act on one pull request at once: the
[drive](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) that
runs its review rounds, a second driver in another clone of the repository,
and the [dispatchers](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
of several hosts that each start drives. Without a record on the pull
request that all of them read, two drivers would drive it at once, two hosts
would launch one drive twice, and a head could be announced safe to merge
twice, or still be announced once it no longer is. A
[forge claim](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
is that record: a comment on the pull request that says who took which
piece of work, decided by one rule that every reader applies the same way.

This chapter covers these:

- **The takeover claim** (`drive-takeover-claim`): a driver in another
  clone claims the drive of the pull request, either to
  [take it over](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  from a driver whose
  [ledger](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
  heartbeat is older than the lease window, or to start where no driver of
  its clone held it. The drive's own scripts write and read it.
- **The launch claim** (`dispatch-launch-claim`): a dispatching host claims
  one launch of the pull request's drive (a re-arm, a
  [re-drive](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), an
  arm or a takeover), and writes onto the same comment how that launch
  ended. It is one of the dispatcher's
  [shared records](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md),
  read by every other host dispatching the repository.
- **The merge-ready announcement** (`drive-merge-ready`): a driver
  announces that one head of the pull request is converged, green, mergeable
  and clean. It stays only while that holds, and is withdrawn when it stops
  holding.

The follow-up claim, which claims a merged pull request's follow-up, is a
forge claim too, with a chapter of its own:
[the follow-up claim and its result](followup-claim.md). Besides Jig's own
scripts, the claims are read by `jig ask`, whose thread for a pull request
lists its launches, their ends and its announcements, and by any program
that needs to know which host launched a drive, how that launch ended or
whether a head was announced safe to merge.

## How a claim is written and read

A claim is a comment on the pull request. It opens with its kind's own line,
holds its record in the second marker, in the record envelope's marker form,
and ends with text a person reads:

- a takeover claim opens with `<!-- drive-pr-takeover-claim -->`, its record
  in `<!-- drive-pr-takeover-claim-data … -->`;
- a launch claim opens with `<!-- jig-dispatch-launch-claim -->`, its record
  in `<!-- jig-dispatch-launch-claim-data … -->`;
- an announcement opens with the line
  `**Safe to merge from the driver's perspective.**`, its record in
  `<!-- drive-pr-merge-ready-data … -->`, and ends with
  `<!-- drive-pr-merge-ready: <head> -->`. Its record's key and that last
  marker name the same head, or it does not read.

A comment that holds a claim's marker without opening with its line is no
claim: a person quoting one is not read as one.
[The hidden comment markers' chapter](comment-markers.md#the-envelope-and-the-markers-form)
gives the envelope and the marker form; each claim's own fields are below.

A claim counts only from a trusted author: the reader's own forge login, or
an author the forge vouches for as an owner, member or collaborator of the
repository. A driver reads an announcement by that association alone,
whatever login posted it, so two drivers signed in as different accounts
still see each other's. Of the trusted claims on one key and generation, the
earliest comment wins:

- **Takeover**: the key is `takeover:<generation>`, the ledger generation the
  claimant read. A driver that finds a claim in force from another clone,
  newer than its own, stops at its next round boundary, and leaves its own
  comment as the record of the claim it lost. A claim made more than the
  lease window after a winner whose driver never wrote the ledger past that
  generation replaces it, so an abandoned claim never holds the drive for
  good.
- **Launch**: the key is `drive` and the generation is the attempt. A host
  claims the attempt after the latest; a claim that loses its attempt is
  withdrawn. The latest attempt's winner with no end holds the pull
  request's launches for every host, and past it only a takeover claims.
  Only the host that made a claim writes its end, onto the same comment.
- **Merge-ready**: the key is `merge-ready:<head>`. Of the announcements of
  one head the earliest stands and the others are withdrawn, and an
  announcement of a head the pull request moved past is withdrawn too.

The forge cannot create a comment only if none exists, and its listing can
lag behind a post, so a claimant reads its claim back after posting it and
again before each act the claim guards. Two claims whose read-backs each lag
past the other's comment can both read themselves the winner; the earlier
comment still wins at the first read that lists both, and the losers stand
down then.
[RECORDS.md](../RECORDS.md#on-the-forge-and-the-tracker) has the rule and
what it cannot close in full.

## What a reader does with a claim that does not read

A claim does not read when its record breaks the envelope's strict form, its
version is newer than the one listed below, it names a value this chapter
does not list for a closed field, or a field does not have the type and
form its schema gives it. A reader never guesses what such a claim meant:

- a trusted takeover claim that does not read counts for nothing;
- a trusted launch claim that does not read leaves the pull request's drive
  unlaunched by every host until a person settles it;
- a trusted announcement that does not read names no head: no driver
  removes it as an announcement of another head, and a driver that would
  announce refuses instead, for a person to settle.

A field this chapter does not list is not read, and a reader keeps reading
the rest of the claim. Some fields are read loosely: an end's `by` and
`cause` read as absent when they name a value the closing report does not
list, and a launch's `conflictStop` reads as false unless it is `true`.

Earlier forms still read: a takeover claim written before claims carried
the envelope, whose data marker holds `actor`, `clone`, `generation` and
`at` with no `kind`; and an announcement written before it carried a record,
which only ends with its head marker.

## The records

<!-- protocol:generated source=plugin/shared/records/registry.ts#RECORD_KINDS -->

| Kind | Medium | Markers | Version | Key | Meaning |
| --- | --- | --- | --- | --- | --- |
| `drive-takeover-claim` | forge | `drive-pr-takeover-claim`, `drive-pr-takeover-claim-data` | 1 | `^takeover:\d+$` | A driver's claim to take a drive over from another clone's stopped driver, one per ledger generation: of the claims on one generation the earliest trusted one wins, and the others stand down. |
| `dispatch-launch-claim` | forge | `jig-dispatch-launch-claim`, `jig-dispatch-launch-claim-data` | 1 | `^drive$` | A dispatching host's claim of one launch of the pull request's drive (a re-arm, a re-drive, an arm or a takeover), and how that launch ended, so no other host dispatching the repository launches it twice. |
| `drive-merge-ready` | forge | `drive-pr-merge-ready`, `drive-pr-merge-ready-data` | 1 | `^merge-ready:[0-9a-f]{7,64}$` | A driver's announcement that one head of the pull request is converged, green, mergeable and clean, posted only while that holds and withdrawn when it stops holding. |

<!-- /protocol:generated -->

## The launch claim's closed values

<!-- protocol:generated source=plugin/shared/records/forge-claim-values.ts#LAUNCH_CLAIM_VALUES -->

| Field | Value | Meaning |
| --- | --- | --- |
| `action` | `rearm` | The launch re-arms the pull request's drive: an arm where no drive ran, a re-arm of a stopped one, or, with `change`, a re-drive. |
| `action` | `takeover` | The launch takes the drive over from a driver whose ledger still says it runs but whose heartbeat has gone silent past the lease window. |
| `end.state` | `ended` | The launch ran and its stage exited: `exit` is the exit. |
| `end.state` | `died` | The launch did not run to its exit: `reason` says why, and nothing more is known of its stage. |

<!-- /protocol:generated -->

## The claims' fields

Beside the envelope's, Jig's writers write these fields into a claim's
record, and no other. "Always" and "sometimes" say whether every claim of
the kind carries a field or only some. A launch's end is in one of the two
end states above; its fields say which ends carry them. The merge-ready
announcement carries no field beside the envelope's: its key names the
head.

<!-- protocol:generated source=plugin/shared/records/forge-claim-values.ts#FORGE_CLAIM_FIELDS -->

| Claim | Field | Type | Carried | Meaning |
| --- | --- | --- | --- | --- |
| `drive-takeover-claim` | `generation` | integer | always | The ledger generation the claimant read before it claimed: the claim's key is `takeover:<generation>`, and of the trusted claims on one generation the earliest wins. |
| `drive-takeover-claim` | `actor` | string | always | The claiming driver's session, as the drive ledger names its driver: the driver that takes the drive over. |
| `drive-takeover-claim` | `clone` | string | always | The clone the claiming driver runs in: a driver that finds a claim in force from another clone stops at its next round boundary. |
| `dispatch-launch-claim` | `generation` | integer | always | The attempt the claim makes, from 1: a launch claims the attempt after the latest, and of the claims on one attempt the earliest trusted one wins. |
| `dispatch-launch-claim` | `pr` | integer | always | The number of the pull request the claim is on; a claim whose record names another pull request does not read. |
| `dispatch-launch-claim` | `action` | string | always | What the launch does: one of the actions listed above. |
| `dispatch-launch-claim` | `record` | string | always | The claiming host's launch record, in the dispatcher's form `<yyyymmdd>T<hhmmss>Z-<8 hex>`. |
| `dispatch-launch-claim` | `host` | string | always | The claiming host, as a digest of its dispatcher's database instance: a public comment names no machine, and that host recognises its own claim. Only that host writes the launch's end. |
| `dispatch-launch-claim` | `facts` | string | always | The drive ledger's facts the launch acts on, in words (its generation, its exit, its heartbeat); empty where it acts on none. |
| `dispatch-launch-claim` | `change` | string | sometimes | For a re-drive, the change it acts on (a head, and for a stop on a conflict its base's head), which is re-driven once. |
| `dispatch-launch-claim` | `earlier` | string[] | sometimes | For a re-drive, the changes an earlier launch of the same launch record acted on, which are not re-driven either. |
| `dispatch-launch-claim` | `owner` | boolean | sometimes | Whether the claiming host owns the repository's board, notifications and history rows; absent where that host does not say. |
| `dispatch-launch-claim` | `conflictStop` | boolean | sometimes | Written only as true: the re-drive is of a drive that stopped on a conflict with its base, which a person settles when the re-drive leaves it so. |
| `dispatch-launch-claim` | `end` | object | sometimes | How the launch ended, written onto the claim by the host that made it; absent while it has not ended, as far as that host has written. A claim on the latest attempt with no end holds the pull request's launches for every host. |
| `dispatch-launch-claim` | `end.state` | string | every end | How the launch ended: one of the end states listed above. |
| `dispatch-launch-claim` | `end.at` | string | every end | When the launch ended, as an ISO 8601 time. |
| `dispatch-launch-claim` | `end.exit` | integer or null | every ended end | The stage's exit, in the numbering of the drive's exit codes; null when it ended on a signal. |
| `dispatch-launch-claim` | `end.outcome` | string or null | some ended ends | Null, as a drive's launch writes it. A launch's end has one form for a drive and a follow-up, so a reader also accepts a follow-up's answer here, `done` or `failed`, and an end without the field. |
| `dispatch-launch-claim` | `end.by` | string | some ended ends | Who wrote the run's closing report (agent, driver, wrapper, steward or person), or none when it left none. The report's own text stays on the host; a value a reader does not know reads as absent. |
| `dispatch-launch-claim` | `end.cause` | string | some ended ends | Why the run fell short, from the closing report's closed list of causes, when the report named one; a value a reader does not know reads as absent. |
| `dispatch-launch-claim` | `end.reason` | string | every died end | Why the launch died, in words. |
| `dispatch-launch-claim` | `end.executed` | boolean | some died ends | Written only as false, with durable evidence that the launch's reservation never executed; absent otherwise. |

<!-- /protocol:generated -->

## JSON Schemas

Each claim's record, as its data marker holds it, has a schema generated
from the description its reader validates against:
[the takeover claim](schemas/drive-takeover-claim.json), which also
describes the form written before the envelope;
[the launch claim](schemas/dispatch-launch-claim.json); and
[the merge-ready announcement](schemas/drive-merge-ready.json). What a
schema cannot say, the reader still checks: that a takeover claim's key
repeats its generation, that a launch claim names the pull request it is
on, and that an announcement's record and its head marker name the same
head.

The claims, their markers, fields and closed values, for a program in any
language: [data/forge-claims.json](data/forge-claims.json).
