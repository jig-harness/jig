---
name: priorities
description: "Change what a repository or host declares as its priorities: validate a priorities/v1 record, prepare a record change as a pull request plan or a host weights-file change as a local diff, and show how the dispatcher's shortlist would move. Never starts work or edits tracker Priority. Not for starting work (use do-item) or commanding stations (use operator)."
argument-hint: "[validate | weights | shortlist | the change you want]"
disable-model-invocation: true
---

# Priorities: declare what the line should start next

A [priorities record](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
states a level's objectives (`priorities/v1`); the host's
[weights file](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
says how the weighted [priority lanes](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)
share the starts. The dispatcher ranks a shortlist from them and reports
it; only a host that sets `priorities.enforce` starts its pickups in that
order. This skill prepares and checks a
change to either and shows the shortlist it would give. The human's page is
[README.md](README.md); the fields are in
[CONFIGURATION.md](../../CONFIGURATION.md#priorities). Run from the consumer
repository; `<skill-dir>` below means this installed skill's absolute
directory.

It never launches work, never writes the tracker and never changes an
issue's Priority field. To start an item hand over to `/jig:do-item`; to
hold, release or drive a station, to `/jig:operator`.

## Which change

| The person wants to change | Where it lives | What you prepare |
| --- | --- | --- |
| The repository's objectives, their classes, epics or shares | `.config/priorities.yaml` on the default branch | A pull request plan |
| How the lanes share starts on this host | `$JIG_HOME/weights.local.yaml` (`~/.jig/weights.local.yaml`), `lanes:` | A local diff for the host's owner |
| What this host serves for one person | the person's `priorities` in the host dispatch file (validated here; the dispatcher does not read it yet) | A local diff for the host's owner |
| The site's record | the hub's operator configuration | Nothing: name the hub's procedure and stop |

Write the record from the person's stated goals. Never infer objectives from
the order of a plan page or from the tracker's Priority fields. When the
goal, the class (`core`, `tactical`, `peripheral`) or the epics are unclear,
ask: with Claude Code's `AskUserQuestion` where the session can use it, as a
plain-text numbered question in any other interactive runtime (one numbered line per option, the recommended one first and marked as the default where there is one, which the reply `default` takes), and with
nobody to answer, stop and state the question rather than pick.

## Check what is there

```sh
bun "<skill-dir>/scripts/priorities.ts" validate [--file <path>]
bun "<skill-dir>/scripts/priorities.ts" weights [--file <path>]
```

`validate` exits 0 for a valid record, 1 with every problem named (an
unknown field, a duplicate id, an empty selector, a negative value, a share
above one, a lane's shares above one, both or neither of `epics` and
`refs`), 2 for a usage error. A reference to another level's objective is a
note: it resolves only where that level's record is read. `weights` prints
each lane's weight and share and exits 1 when the file has a problem; a
problem takes the lane, or every weighted lane, out of rotation, and the
tick report names it too.

## Preview the shortlist

Write the proposed file to a scratch path, then compare it with the
dispatcher's newest ranking of this repository on this host:

```sh
bun --no-env-file --config="<skill-dir>/../../dispatch/bunfig.toml" "<skill-dir>/scripts/priorities.ts" shortlist [--repo owner/name] [--record <proposed.yaml>] [--weights <proposed-weights.yaml>] [--json]
```

It re-ranks the same tracker snapshot with the proposed record or weights
and prints the positions added, removed and moved, and each lane share that
changes. With no ranking on this host it says so: show the validation alone.
A proposed weights file with a problem exits 1 with the problems named (in
`problems` with `--json`): fix the file before showing the diff.

## Prepare the change

- **Repository record.** Prepare a pull request plan: a branch name, the
  edited `.config/priorities.yaml` (with `revision` raised by one), the
  `validate` output and the shortlist diff for its body. Show the plan and
  stop: the person, or the session they hand it to, opens the pull request
  under the repository's pull-request policy.
- **Weights file or a host record.** Prepare a local diff: write the
  proposed file beside the current one and show `diff -u <current>
  <proposed>` with the `weights` or `validate` output and the shortlist
  diff. The host's owner applies it; the dispatcher reads the weights file
  again on its next tick, with no restart. Never put a host record or a
  person's identity in a pull request.

## Batchable work

When a signal suggests several small issues could go in one pull request,
ask `work-batch`'s own rules, never a copy of them:

```sh
bun "<skill-dir>/scripts/priorities.ts" batchable --issues issues.json
```

It passes the issues in `issues.json` (a JSON array in pool form, as
`/jig:work-batch` documents) to work-batch's eligibility mode and prints
its verdicts. Report them; hand any
batch to `/jig:work-batch`.
