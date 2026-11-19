# Pull-request labels Jig writes and reads

Version 1 · stable

A repository can have Jig show on each pull request where its
[drive](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) or its
follow-up after the merge stands, as a label, and can let a person tell the
[dispatcher](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) what
to do with a pull request by adding one. This chapter is for a program that
filters or acts on those labels: a dashboard, a board, a repository's own
automation.

The labels are off until the repository sets `dispatch.labels.enabled`, and
every name carries the repository's prefix, `dispatch.labels.prefix`
(`jig:` by default, which the tables below show). `jig dispatch labels`
creates the set on the [forge](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (the service that hosts the
repository and its pull requests), with each label's meaning as its description
([configuration](../CONFIGURATION.md#dispatch)).

## State labels

A state label says where a pull request's drive, or a merged pull request's
follow-up, stands. Each pull request Jig manages carries at most one. The
drive's ledger (the record a drive keeps of its rounds) is the truth: the
dispatcher's tick projects every managed pull request's ledger again and
corrects a state label that disagrees, one a person edited or one a killed
drive left behind included, so a reader treats a state label as a view of
the ledger, never as a command. A drive and a follow-up each write only the
states they own, as soon as they change; `held` is the one open state no
ledger gives, carried by a pull request waiting its turn in a
[serialized area](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), an area of the repository the dispatcher drives one
pull request at a time. A reader that meets a
label with the prefix that neither table lists ignores it.

<!-- protocol:generated source=plugin/shared/pr-labels/projection.ts#STATE_LABELS -->

| Label | Written by | Meaning |
| --- | --- | --- |
| `jig:driving` | drive, tick | A drive runs on this pull request, or the dispatcher re-arms the one that stopped |
| `jig:converged` | drive, tick | The drive converged at the pull request's head: a person merges |
| `jig:parked` | drive, tick | The drive stopped on something only a person settles |
| `jig:stale` | tick | Its drive converged then went stale, or stopped or parked on a conflict: the dispatcher re-drives it |
| `jig:held` | tick | Waits its turn in a serialized change area: the dispatcher drives it once it leads |
| `jig:followed-up` | followup, tick | Merged, and its follow-up is done |
| `jig:followup-failed` | followup, tick | Merged, and its follow-up failed: a person acts |

<!-- /protocol:generated -->

### Which stop earns which label

Where state labels are on, each stop of a drive is labelled by one table of
exits (`plugin/skills/drive-pr/scripts/lib/status/exit-classes.ts`), which the
dispatcher's ledger classifier reads too. A recorded person's stop is parked
whatever its exit, so it takes precedence over the mapping below; for the rest
(the exit codes are the [drive-exits chapter's](drive-exits.md)):

- `0` is labelled converged, while the head is still the verified head;
- parked: the park `8`; a stop only a person settles (`1`, `2`, `6`, `7`,
  `22` and any code the registry does not name); a person's stop (`18`,
  `19`, and a recorded stop through `drives.ts`, which names no exit); and a
  stop the dispatcher re-drives (`9`, `12`, `14`, `15`, `21`, `23`), which a
  dispatcher's tick turns into stale where one runs;
- driving: `4` and `16`, which the dispatcher re-arms, and `11` and `13`, a
  second driver refused while another drives;
- nothing: `5`, a pull request no longer open; `20`, whose ledger is the
  successor's; and a stop with no exit and no person's stop recorded.

## Command labels

A command label is added by a person, and read by the dispatcher's tick;
no writer adds one. `drive` is carried out once the pull request has a
drive ledger, and is then replaced by its state label. `hold` stays until a
person removes it. While it is there, the dispatcher starts nothing on the
pull request and notifies nobody of it, and the drive's own label writes
stand down; the dispatcher's tick still keeps the pull request's state
label current.

<!-- protocol:generated source=plugin/shared/pr-labels/projection.ts#COMMAND_LABELS -->

| Label | Meaning |
| --- | --- |
| `jig:drive` | A person asks the dispatcher to drive this pull request |
| `jig:rearm` | A person asks the dispatcher to re-arm a stopped drive in its existing tree |
| `jig:hold` | A person stands the dispatcher down from this pull request |

<!-- /protocol:generated -->

Send a rearm with [`jig send`](addresses.md#send). The command binds the
request to the stopped drive. Its label expires when the drive moves on or
the pull request closes.

How the dispatcher reads each label, and the settings that turn them on:
[the configuration reference](../CONFIGURATION.md#dispatch). The same
values, for a program in any language:
[data/pr-labels.json](data/pr-labels.json).
