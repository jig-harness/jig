# The drive mailbox

Version 1 · stable

A [drive](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (the
loop that works a pull request's review rounds until it is ready to merge)
runs headless, with nobody at its keyboard. Its mailbox is the one way to
steer or stop it while it runs: a person, the session that started the
drive, `drives.ts --stop` or `jig send` writes a message, and the drive acts
on it at its next checkpoint. This chapter is for a program that writes to
a running drive or reads what it answered.

The mailbox is two files in the working tree the drive runs in, under
`.context/drive-mailbox/` at the tree's root (`DRIVE_PR_MAILBOX_DIR`
overrides the directory). Each holds JSON Lines: one JSON object per line,
of at most 4096 bytes with its newline, appended and never rewritten.

- **`inbox.jsonl`** is written by any sender. A `note` gives the drive's
  passes (each a headless agent session that works one review round)
  context they may read; a `directive` is a command the drive
  enforces whatever its passes do.
- **`outbox.jsonl`** is written by the drive's side: a pass acknowledges or
  answers a message, and the driver acknowledges each directive it acted
  on.

A sender appends one whole line under the per-file lock the mailbox's own
writer takes, so the simplest correct sender is the mailbox's command line,
`bun <plugin>/skills/drive-pr/scripts/mailbox.ts send`. Every line names
the pull request it is for, and a drive reads only its own pull request's
lines. A line whose `kind` or `command` is not listed here, or that lacks a
field its kind always carries, is not a valid message, and a field the
tables do not list is not read. A note that lacks a field a note always
carries is dropped with a warning. A line that is not valid JSON, a note
that carries `command`, `target` or `generation`, and a directive line that
does not parse hold the drive's pushes and end the driver at its next
checkpoint, again on every re-arm, until a person repairs the file: a command
nobody can read is not treated as no command. `mailbox.ts repair` removes a
line that is not valid JSON; a note that carries a directive field, or a
directive of the wrong shape, is valid JSON, so a person corrects or removes
that line by hand. A reader of the outbox ignores a status it does
not know.

How the drive enforces each directive, and the commands that send them:
[drive-pr § The drive mailbox](../skills/drive-pr/SKILL.md#the-drive-mailbox).
The exit codes the drive ends with:
[Drive end states and exit codes](drive-exits.md). The same values, for a
program in any language: [data/mailbox.json](data/mailbox.json).

## The inbox

The kinds of message, in an inbox line's `kind` field:

<!-- protocol:generated source=plugin/skills/drive-pr/scripts/lib/state/mailbox-values.ts#MESSAGE_KINDS -->

| Kind | Meaning |
| --- | --- |
| `note` | Context for the drive's passes, which they may read (`mailbox.ts check`) and acknowledge; it never controls the drive. A note that lacks a field a note always carries is dropped with a warning; a line that is not valid JSON, or a note that carries `command`, `target` or `generation`, is read as a malformed directive and holds the drive's pushes. `mailbox.ts repair` removes the interrupted line; a note that parses but carries a directive field stays until a person edits or removes it. |
| `directive` | A command the drive enforces mechanically, named in its `command` field. A directive line that does not parse holds the drive's pushes and ends the driver at its next checkpoint with exit 1, as an unreadable inbox does, and a re-armed drive ends again until a person repairs the file: `mailbox.ts repair` removes a line that is not valid JSON, while valid JSON of the wrong shape needs a person to correct or remove it. |

<!-- /protocol:generated -->

The directives, in a `directive` line's `command` field. For each of the
directives a `resume` may target, the latest such directive in the inbox
wins:

<!-- protocol:generated source=plugin/skills/drive-pr/scripts/lib/state/mailbox-values.ts#MAILBOX_DIRECTIVES -->

| Command | `resume` may target it | Meaning |
| --- | --- | --- |
| `hold-push` | yes | Holds every push the drive makes through `guarded-push.ts`: the push is refused with exit 17 (`PUSH_HELD`) until a `resume` with target `hold-push`. The drive goes on with its rounds. |
| `pause` | yes | Holds the driver at its next checkpoint, keeping its locks, until a `resume` with target `pause`; one that lasts past `DRIVE_PR_PAUSE_MAX_SEC` ends the drive with exit 19 (`MAILBOX_PAUSE_TIMEOUT`). |
| `stop` | yes | Ends the driver at its next checkpoint with exit 18 (`MAILBOX_STOPPED`), after any running pass finishes; one that also carries `now` ends it at once, cancelling the running pass, with exit 143. One naming a `generation` ends that driver alone; one naming none ends every later driver in the working tree too, until a `resume` with target `stop`. |
| `resume` | no | Clears the directive its `target` names. With target `stop` it also withdraws every stop addressed to a generation. |

<!-- /protocol:generated -->

The fields of an inbox line, and the kinds of message that carry each.
"Always" means every line of that kind carries the field, "sometimes" that
some do; a line of a kind the column does not name never carries it:

<!-- protocol:generated source=plugin/skills/drive-pr/scripts/lib/state/mailbox-values.ts#INBOX_FIELDS -->

| Field | Type | Carried by | Meaning |
| --- | --- | --- | --- |
| `id` | string | note (always), directive (always) | The message's identifier, unique in the inbox; an outbox record names it in its own `id`. |
| `ts` | string | note (always), directive (always) | When the message was sent, as an ISO 8601 time. |
| `kind` | string | note (always), directive (always) | One of the message kinds listed above. |
| `from` | string | note (always), directive (always) | Who sent it: a person's or a session's name, as the sender gives it. |
| `pr` | string | note (always), directive (always) | The number of the pull request the message is for, as nonzero decimal digits with no leading zero (`12`, never `012` or `0`); a drive reads only its own pull request's messages, and a directive whose `pr` is not in that form holds the drive's pushes. |
| `body` | string | note (always), directive (sometimes) | The note's text, or a directive's reason. |
| `command` | string | directive (always) | One of the directives listed above. |
| `target` | string | directive (sometimes) | The directive a `resume` clears; carried by every `resume` and by no other directive. |
| `generation` | integer | directive (sometimes) | The driver generation a `stop` addresses, a positive whole number the driver prints at its start; only a `stop` carries it. |
| `now` | boolean | directive (sometimes) | Always `true` where present, and only beside a `generation`: the driver cancels its running pass at once rather than waiting for it, and exits 143 (`drives.ts --stop`). |

<!-- /protocol:generated -->

## The outbox

The statuses of an outbox line, in its `status` field, and which side of
the drive writes each:

<!-- protocol:generated source=plugin/skills/drive-pr/scripts/lib/state/mailbox-values.ts#OUTBOX_STATUSES -->

| Status | Written by | Meaning |
| --- | --- | --- |
| `received` | pass | A pass saw the inbox message the record's `id` names (`mailbox.ts ack`), and has not answered it; the message is no longer shown as unseen. |
| `done` | pass | A pass answered the inbox message the record's `id` names (`mailbox.ts respond`); the answer is in `response`. |
| `ack` | driver | The driver of the record's `generation` acted on the `stop` or `pause` directive the record's `id` names, so a sender sees the directive took effect. |

<!-- /protocol:generated -->

The fields of an outbox line, and the statuses that carry each:

<!-- protocol:generated source=plugin/skills/drive-pr/scripts/lib/state/mailbox-values.ts#OUTBOX_FIELDS -->

| Field | Type | Carried by | Meaning |
| --- | --- | --- | --- |
| `id` | string | received (always), done (always), ack (always) | The `id` of the inbox message the record answers. |
| `ts` | string | received (always), done (always), ack (always) | When the record was written, as an ISO 8601 time. |
| `pr` | string | received (always), done (always), ack (always) | The number of the pull request the record is for: a record acknowledges only that pull request's message. |
| `status` | string | received (always), done (always), ack (always) | One of the outbox statuses listed above. |
| `response` | string | done (always) | A pass's answer, never empty; only a `done` record carries it. |
| `generation` | integer | ack (always) | The generation of the driver that acted on the directive. |

<!-- /protocol:generated -->

## JSON Schemas

[Inbox message](schemas/mailbox-message.json) and
[outbox record](schemas/mailbox-outbox.json) describe one JSON line each.
