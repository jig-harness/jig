# priorities

**What problem this solves.** Without a written statement of priorities, the
only ranking a dispatcher has is each issue's own Priority field. An epic
marked important does not lift its children; a long-running goal and a
small side project compete only through whoever last edited a field; and
nobody can see what a declared ranking would start next. With this skill a
repository writes its objectives down in one checked file, the host says how
its kinds of work share the starts, and the dispatcher reports the
shortlist those give beside what it actually started.

## What it does

- **Checks a priorities record** (`.config/priorities.yaml`, format
  `priorities/v1`): each objective's id, class (`core`, `tactical` or
  `peripheral`), purpose, end state, owner, the epics or labels it covers,
  and an optional share of its lane's starts. Unknown fields, duplicate ids,
  empty selectors, negative values and shares above one are refused, each
  named.
- **Reads the host's weights file** (`~/.jig/weights.local.yaml`) and shows
  each lane's weight and share. A broken entry takes its lane out of
  rotation rather than guessing.
- **Shows the shortlist diff** a proposed record or weights file would give,
  against the dispatcher's newest ranking on the host.
- **Prepares the change**: a pull request plan for the repository's record,
  a local diff for the host's weights file or a person's host record, which
  never goes into a pull request.
- **Asks work-batch** which issues may be batched, through its eligibility
  mode, instead of keeping its own rules.

It never starts work and never edits a tracker's Priority field. In this
release the shortlist is a report only: the dispatcher's selection of what
to start does not change.

## The lanes

| Lane | Holds | Default weight |
| --- | --- | --- |
| `urgent` | Urgent issues among the tick's pickups, bug or not | none: always first |
| `bug-high` | assigned High bugs | none: next |
| `core` | work whose allocation owner is a core objective | 50 |
| `tactical` | work owned by a tactical objective | 25 |
| `peripheral` | work owned by a peripheral objective; its weight is a floor | 10 |
| `bug-other` | assigned Medium and Low bugs, then bugs with no priority | 15 |

The design, with the ranking rules and a worked week, is
[design/priorities-and-overview.md](https://github.com/jig-harness/jig/blob/main/design/priorities-and-overview.md).

## Use it

Ask for `/jig:priorities` with the change you want ("make the export work
core", "pause the peripheral lane on this host"). The agent's procedure is
[SKILL.md](SKILL.md); the fields are in
[CONFIGURATION.md](../../CONFIGURATION.md#priorities).
