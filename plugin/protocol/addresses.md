# Addresses and the verbs of `jig send`

Version 1 · provisional, moved by [plan item 39](https://github.com/jig-harness/jig/issues/485), [plan item 42](https://github.com/jig-harness/jig/issues/541)

An [address](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
names one [station](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
of the execution line (one fixed step a piece of work passes through) on one
piece of work: the pick-up of a tracker item, the drive of a pull request,
the follow-up of a merged one. `jig ask <address>` answers where that
station stands, and `jig send <address> <verb>` tells it what to do. This
chapter is for a program that forms addresses or sends verbs: a dashboard,
a chat bridge, a workspace app, a script of a repository's own.

An address is derived from the records the station leaves, never declared,
so nothing registers one and an address nobody holds is still valid: `jig
ask` answers that nobody holds it
([ADR-0014](https://github.com/jig-harness/jig/blob/main/docs/adr/ADR-0014-addresses-are-derived-and-requests-are-records.md)).

## The form of an address

An address is `station@owner/name#key`, such as `drive@jig-harness/jig#456`:

- **The station** is one of the stations listed below.
- **The repository** is `owner/name` as the
  [forge](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (the
  service that hosts the repository and its pull requests) writes it. On
  input its short name is accepted where the machine's dispatch file lists
  exactly one repository of that name (`drive@jig#456`), and it may be left
  out inside a checkout of the repository, which then names it
  (`drive#456`).
- **The key** is the piece of work, in the form its station's key takes: a
  pull request's number, with or without a leading `#`, or the tracker's
  item key as the tracker writes it (`#12` on GitHub Issues, `ENG-4` on
  Linear or Jira). Some shells give `#` a meaning of its own, so the key may
  also follow as a second argument: `drive@jig 456`.

Every answer prints an address in full: the repository as `owner/name`, a
pull request's key after `#` without a second one, an item key as the
tracker writes it. A program that compares addresses compares that form.

A malformed address, an unknown station, a short name that names no
repository or two, and a key not in its station's form are each refused as
a usage error (exit `2`), with a reason that lists the valid stations where
the station is at fault.

## Stations

A reader that meets a station this table does not list refuses the address.

<!-- protocol:generated source=plugin/shared/address.ts#STATIONS -->

| Station | Its key | Meaning |
| --- | --- | --- |
| `pickup` | the tracker's item key | The pick-up of a tracker item: held by the session that claimed the item to start its work |
| `drive` | the pull request's number | The drive of an open pull request: the driver that runs its review rounds, whether a dispatched re-arm or takeover or one armed by hand |
| `followup` | the pull request's number | The follow-up of a merged pull request: the pass, a dispatcher's tick or a person's run, that settles what the merge still owes |

<!-- /protocol:generated -->

## The verbs of `jig send`

`jig send` writes one record of a kind the line already reads, and exits;
the record's reader acts on it at its next run. Each verb is taken by the
stations its row names, and refused, as a usage error, at any other. A
person's command is refused in a session the line started (a dispatched
launch, or a drive's pass, which carries `JIG_LAUNCH`); the mailbox
directives are not a person's commands, and such a session may send them.
`--dry-run` shows what a verb would write without writing it.

<!-- protocol:generated source=plugin/send/lib/verb-values.ts#SEND_VERBS -->

| Verb | Arguments | To | A person's command | Meaning |
| --- | --- | --- | --- | --- |
| `assign` | — | `pickup` | yes | Hand the item to the line: assign it to the factory identity and move it into the first dispatch state, for the dispatcher's next tick to pick up |
| `drive` | — | `drive` | yes | Ask for a drive on a pull request that has none: the drive command label, which the dispatcher's next tick arms a drive for |
| `rearm` | — | `drive` | yes | Ask for a stopped drive to be re-armed in its existing working tree: the rearm command label, which the dispatcher's next tick reads |
| `hold` | — | `drive`, `followup` | yes | Keep the line off a pull request: add the hold command label, which every stage of the dispatcher respects |
| `release` | — | `drive`, `followup` | yes | Withdraw a hold: remove the hold command label, so the dispatcher's next tick takes the pull request up again |
| `answer` | `<key> <text> \| <key> --approve\|--choose <option> [--note <text>] [--decision <digest>] \| --all --approve [--decision-set <token>]` | `drive`, `followup`, `pickup` | yes | Answer a parked question or a need's decision, in the person's own words or by approving or choosing one of its options: one answer comment per item, which the re-arm or the dispatcher's next tick reads |
| `pause` | — | `drive` | no | Pause a running drive at its next round boundary: a directive in the mailbox of the working tree that holds the drive on this machine |
| `resume` | `<hold-push\|pause\|stop>` | `drive` | no | Withdraw the mailbox directive it names, so the drive goes on past it |
| `stop` | — | `drive` | no | Stop a running drive at its next round boundary: a mailbox directive |
| `hold-push` | — | `drive` | no | Hold a running drive's pushes: a mailbox directive the driver checks before each push |

<!-- /protocol:generated -->

What each verb checks before it writes, which record it writes and who
reads it are in
[the plugin's README](../README.md#telling-a-station-what-to-do).
