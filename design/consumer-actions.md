# Consumer actions: design

**What problem this solves.** Jig changes fast, and some of its changes ask
something of the repositories that use it. A release may change how a drive
stops, so a repository's own runbook is now wrong. It may rename a
configuration key, or need a newer plugin source on a machine. Nothing tells
a consumer repository which changes those are. A person reads the changelog
by hand, release by release, and tests each entry against the repository from
memory. The follow-up of a Breaking release has no list of consumers to file
against. Jig names none, and the question "which repositories are affected?"
stops the work. With this built, each repository is checked against the
changes since it last reconciled, and the result is one short list: what it
must do, what it is advised to do, and what does not apply, each with the
place that shows why. A person is told once, and files the repository's own
tracker item when they choose.

This is the design of [plan.md](plan.md) item 43 (issue #566). Nothing is
built yet. The pieces it joins already exist: change notes and their
`**Breaking:**` marker ([changes/README.md](../changes/README.md)), the
audit's `since` and `deprecated` marks on configuration fields
([config-schema.yaml](../plugin/skills/audit/config-schema.yaml)), `jig doctor`
([plugin/runtime/doctor.ts](../plugin/runtime/doctor.ts)), the dispatcher's
stages and their `notify` ([dark-factory-dispatch.md](dark-factory-dispatch.md)),
and the Breaking-changes arm of [`/followup`](../.claude/skills/followup/SKILL.md).

## How it works

### Three levels, two strengths

A change asks something at one or more **levels**, the place where the
consumer acts:

| Level | What the consumer changes | Judged against | Recorded in |
|-------|---------------------------|----------------|-------------|
| `machine` | what runs on the host that drives the repository: the plugin source, a scheduled job, a program | the host's present state | nothing: it is read again at every run |
| `configuration` | the repository's `.config/jig.yaml` | the repository's default branch | `jig.reconciled` |
| `instructions` | the repository's own agent instructions, runbooks and documents that describe Jig's behaviour | the repository's default branch | `jig.reconciled` |

A machine-level action describes the state of one host, so it is never
recorded in the repository: a repository driven from two hosts would otherwise
lose the second host's stale state the moment the first took the item. The
check reads the host's state at every run, reports the action while the state
is wrong, and stops when it is right.

Each action has one **strength**: `required` (the repository is wrong or
broken until it acts) or `advised` (it works, and acting makes it better or
avoids a coming removal). An entry that asks nothing says `none`, so a reader
can tell "asks nothing" from "nobody said".

### The change note declares it

A change-note entry that a consumer must act on, or is advised to, carries a
**consumer action** in the same list item, after its description. Nothing is
nested: a note holds only headings, list items, paragraphs, links, code spans
and emphasis ([changes/README.md](../changes/README.md)), and the declaration
fits them.

```markdown
- **Breaking:** A stopped drive is re-armed by the dispatcher, not by hand.
  **Consumer action:** required at instructions, machine. Remove the manual
  restart step from runbooks and point the plugin source at the current
  release. **Detect:** `text:restart the drive`, `plugin-source:old`.
```

- `**Consumer action:**` is followed by the strength, `at`, one or more levels
  separated by commas, a full stop, and the instruction in plain language, at
  most 400 characters. An entry that asks nothing writes
  `**Consumer action:** none.` A later release withdraws a wrong or obsolete
  action with `**Consumer action:** retracts <id>.`, naming the id below.
- `**Detect:**` is optional and lists **hints**, each a kind and a value:

  | Kind | Means the repository is affected when |
  |------|---------------------------------------|
  | `config:<dotted.key>` | the key is set in `.config/jig.yaml`, or, for a new key written as `config:!<dotted.key>`, is absent |
  | `text:<phrase>` | the phrase appears, as a literal, case-insensitive substring, in the repository's tracked instruction files and runbooks (see [What is read](#what-is-read)) |
  | `file:<glob>` | a tracked file matches the glob, relative to the repository root |
  | `plugin-source:<kind>` | the plugin source the host's agent settings name is of that kind (`old`, `path`, `project-scope`) |

  A hint is evidence for a person, never a command: the check reports where
  it matched and never edits.
- The changelog check ([plugin/skills/changelog](../plugin/skills/changelog/SKILL.md))
  validates the form: unknown levels, strengths or hint kinds, a hint with a
  path that leaves the repository, a text over the length cap. It also
  requires a `**Breaking:**` entry to carry a `**Consumer action:**`, **only
  where the repository sets `changelog.consumer_actions: true`**, which Jig's
  own repository does. A consumer that runs the check on its own changelog
  never gets the new finding. A `**Consumer action:**` on an entry that is not
  Breaking is allowed: `advised` is normally not breaking. The writing guide
  in `changes/README.md` asks the author, for every `plugin/` change, "does a
  consumer have to do anything?".
- An action's text is read by people and shown to agents as quoted data (see
  [What is trusted](#what-is-trusted)); the check never acts on it.

An action's **id** is the release's version and the first eight hex digits of
the SHA-256 of its normalized description (the entry's text before the
declaration, whitespace collapsed), for example `0.157.0#3fa9c2b1`. It does not
depend on the entry's position, so reordering or regenerating a release does
not change it, and a dismissal a repository committed keeps matching. Two
entries with the same text in one release share an id and are one action.

### The record in the plugin

The release step already writes each note's entries into CHANGELOG.md. It
also derives a **consumer-actions record**, `plugin/consumer-actions.json`: for
each release that has at least one action, its version, and each action's id,
strength, levels, text and hints. Releases without an action are not listed,
so the file grows by the number of releases that ask something, not by every
release. It is a derived file (regenerated, never edited by hand, with a
freshness check beside the other derived files,
[M2](../modules/M2-generated-artifact-freshness/README.md)) and ships in the
plugin, so the check reads it from the installed copy: no network, and exactly
the version the machine runs. The check never reads CHANGELOG.md, which is not
in the installed plugin.

The record **starts at the release that ships it**. Earlier releases are not
read: their `**Breaking:**` entries use several spellings, carry no level and
no hint, and would put one person per repository to triage the same history.
A person who wants an earlier release's actions checked writes them into a
record for that release by hand with `jig reconcile --record <file>`; nothing
automates the past.

The record's integrity is the plugin's: it arrives with the plugin the machine
installed, through the channel `jig doctor` already checks. The check refuses
a record whose schema it does not know, whose versions are above the
installed one, or whose ids do not match their text, and says so; it does not
sign the record (see [Left out](#left-out)).

### What derives, and what a note must say

Derive, don't declare: the check finds what it can without a hint.

- **Configuration changes** come from `config-schema.yaml`: a key set in the
  repository that is `deprecated`, and a field added `since` a later version
  than the repository reconciled with, which the audit already lists. No note
  needs a hint for these.
- **The plugin source** comes from the agent settings of the host
  ([doctor](../plugin/runtime/doctor.ts) already reads it).
- **Instructions and runbooks** cannot be derived: whether a repository's
  prose describes the old behaviour is visible only to a phrase a note author
  names. This is the one place a note carries a `text:` hint.

An entry without a hint is reported as **needs a look** at its level, never as
not applicable: silence is not evidence of absence. These are the entries a
person triages; they appear in the filed item as their own section, so the
person who takes the item owns the queue.

### The repository records what it has reconciled

A repository records the Jig version it last **reconciled** with, as
`jig.reconciled` in `.config/jig.yaml`: a version string, committed, so it
travels with the repository to every machine that drives it. It is the
repository's own statement, made by the repository's own change. The check
never writes it.

- **Only moves forward.** The value is a version, compared as a version. The
  change that sets it sets it to the highest version its item covered, and the
  item says "unless it already names a later version". Merging two items out
  of order never moves it back, and one open item covers every release up to
  its version, so the field is never set past a release whose item is open.
- **The baseline.** The check reads the actions after the baseline and up to
  the installed version. The baseline is, in order: `jig.reconciled`; else the
  plugin version of the repository's last audit record; else the first
  release in the record. Because the record starts at one release and lists
  only releases with an action, a first run reports at most the actions since
  that release, however old the audit record is.
- **Nothing applies.** A run that finds every action not applicable has
  nothing to commit, and a repository does not open a pull request only to
  move a number. The machine's record (below) holds a `checked_through`
  version per repository, so the same actions are not reported again on that
  host. A run elsewhere, without that record, evaluates them again, which is
  cheap and local.
- **A dismissal** (the action does not apply, with a reason) is written into
  the same change as `jig.reconcile_dismissed`, a list of `<id>: <reason>`,
  with a reason of at least a sentence. A dismissed **required** action is
  still evaluated: when its hint still matches, the report lists it as
  `dismissed, evidence present`, so a field cannot silence it. The check lists
  dismissals whose id is at or below `jig.reconciled` as removable.

A separate record on the machine, in the dispatcher's state, holds only what
was **reported**: for each repository, the ids notified, the ids filed with
their tracker item, `checked_through`, the last result's counts and the time.
It is not the source of truth for what the repository has taken.

### One check, three ways to run it

The check is `jig reconcile`, a component of the `jig` command
([plan item 35](plan.md)), so the dispatcher can run it without an agent. A
skill, `/jig:reconcile`, wraps it for a person in a session, for the steps
that need judgment: reading a hint's matches in context, wording the items.

```text
jig reconcile [--repo <path>] [--record <file>] [--from <version>] [--json]
jig reconcile file [--repo <path>] --entry <id> [--entry <id> ...]
```

- **The first form reads only** and prints the report: **required**,
  **advised**, **needs a look**, **dismissed** and **not applicable**, each
  entry with its id, version, levels, text and evidence. Exit codes: `0`
  nothing required, `4` at least one required entry is open, `1` it could not
  read, `2` usage. A job or script branches on `4`. `--record` reads a record
  at a path instead of the installed plugin's, which `/followup` uses on
  Jig's own checkout.
- **The second form files** one tracker item for the entries a person named
  with `--entry`, through the repository's own tracker configuration
  (`issue_tracker.*`, [Tracker operations](../plugin/skills/do-item/SKILL.md#tracker-operations)).
  It refuses without `--entry`. The item covers every named entry from every
  release up to the highest, so a repository ten releases behind gets one
  item, not ten. It has a section for required entries, one for advised, one
  for the ones that need a look, and ends with the step that sets
  `jig.reconciled` (and records dismissals). The item carries the marker
  `jig-reconcile: <ids>` in its body. Before creating anything the command
  searches the repository's tracker for an open item with that marker for any
  of the ids, and it adds to that item as a comment instead of opening a
  second. It writes the machine record after the tracker write; a crash
  between them is repaired by the search on the next run. At most three
  attempts a day per repository, then it stops and says so.
- **`jig doctor`** prints one line, "N Jig changes to reconcile, as of <time>",
  with the command, from the machine record's last result. It runs no scan, so
  doctor stays fast and offline, and it prints nothing when no record exists.

### What is read

The check reads only what the repository tracks and only what a hint names.

- **Which files.** `config:` reads `.config/jig.yaml`. `text:` searches the
  tracked files that are instructions or runbooks: `AGENTS.md`, `CLAUDE.md`,
  every tracked `*.md` under the root, `docs/`, `runbooks/`, `.claude/` and
  `.agents/`, up to 1 MiB each and 2,000 files per run; a repository may add
  or narrow the set with `reconcile.text_globs`. `file:` matches the tracked
  file list. Files are read from Git's tree, not the working directory, so an
  untracked `.env` or an ignored file is never read, a symbolic link is not
  followed, and a path outside the root cannot be named.
- **What a report contains.** Evidence is the **path and line number** of a
  match and the hint that matched. A `text:` match adds the line cut to 80
  characters with any token-shaped string masked. A `file:` match reports the
  path only, never the content. A `plugin-source` hint reports its kind, never
  the settings. The same evidence goes into a filed item and a notification,
  so nothing is in them that is not in the report.
- **Where the files come from.** From a person's checkout, `--repo`. From the
  dispatcher, see the next section.

### What is trusted

An action's text is written by a contributor to Jig and shipped to every
consumer, so it is read as **untrusted data**, as any tracker text is.

- A filed item quotes the action's text under a heading that says it is a Jig
  release note, copied, and not an instruction to an agent. The item is filed
  **unassigned** and carries no `drive` label. The dispatcher's pickup stage
  takes only items assigned to the factory identity
  ([the dispatcher](dark-factory-dispatch.md)), so an item no person assigned
  is never carried out unread. A person reads it and assigns it.
- The check files only into the tracker the **repository's own** configuration
  names, and only when that tracker belongs to the same organization and
  repository as the repository the check ran against; otherwise it refuses and
  reports it. One machine driving several organizations, with one set of
  credentials per organization, cannot send one's evidence into another's
  tracker through a committed configuration change.
- The filing command in a notification is a command line the person runs; its
  inputs are ids, validated against the record's format, and the command passes
  them to the tracker scripts as arguments, never through a shell.
- A wrong action is withdrawn by a later release's `retracts` entry. The check
  stops reporting a retracted id, and when an item filed for it is open, the
  next `file` run comments on that item that the action was retracted.
- A **security fix** asks of a consumer what any required action does. Its
  note's wording is public text on the changelog like every note; the check
  adds no urgency class of its own, and a flaw's disclosure follows
  [SECURITY.md](../SECURITY.md).

### The dispatch stage

`reconcile` joins the dispatcher's stages
(`stages: [rearm, pickup, followup, notify, steer, reconcile]`), enabled per
repository like the others, and on **one host per repository**: a repository
driven from two hosts enables it on one, because the record of what was
notified is per machine.

- **A tree to read.** The dispatcher reads configuration through the forge and
  opens a workspace only on a pull request's head, so it holds no checkout of
  a default branch. The stage keeps one bare, single-branch clone per
  repository in the dispatcher's state directory and runs
  `git fetch --depth 1 <default branch>` into it, then reads files from that
  tree with `git`. One fetch per run, no forge reads for file content, so the
  tick's shared forge budget is untouched. The fetch uses the credentials the
  dispatcher already uses for the repository. A repository that cannot be
  fetched is reported as unreadable and skipped. The clone is a resource
  [`jig gc`](resource-gc.md) is taught to remove when the repository leaves
  the dispatch file.
- **When it runs.** A tick considers a repository when the installed plugin
  version is newer than the version it last checked, or when its default
  branch moved (one `git ls-remote`) while a required or needs-a-look entry
  is open, so the merge of a repository's own reconcile change is noticed. At
  most once an hour per repository, and a repository with no action in the
  record since its baseline costs one version comparison.
- **Its bounds.** Each repository gets 60 seconds. A tick runs the stage for at
  most two repositories, rotating, and stops when it has spent two minutes of
  the tick, so a release day delays no re-arm or pickup. A repository that
  exceeds its time is reported as timed out and tried again at the next hour.
  The stage measures its runs, fetch time and entries in each receipt.
- **What it does.** It reads only and files nothing. For each repository it
  sends **one notification** through the stage `notify` already has, listing
  the **new** required ids, once per id: ids already in the machine record's
  notified list are not repeated, and the standing renotify the dispatcher
  gives other causes does not apply to this one. A later release with a new
  required entry notifies again, with only the new ids. The message carries
  the `jig reconcile file` command for the ids and the report's path. The
  stage never assigns an item and never opens a pull request.
- **Pause.** The dispatcher's `hold` and a per-repository `reconcile: off` keep
  the stage off a repository.

Because the machine's dispatch file lists the repositories it drives, that
file, not Jig, is the list of consumers the check reaches. Jig names none.

### `/followup` and `/jig:jig`

`/followup` runs after a release is tagged and before a machine has
necessarily upgraded, so the arm cannot read the installed plugin. Its
Breaking-changes arm runs `jig reconcile --json --record
plugin/consumer-actions.json` from the Jig checkout at the release's tag, once
for each repository the machine's dispatch file lists, one at a time with the
stage's 60-second bound. The question "which repositories are consumers" is
answered by the file, so the arm no longer stops on it. When the file lists no
repository, the arm says so and ends. The arm files nothing in Jig's tracker
about a consumer: it reports counts ("N repositories have required actions")
and names no repository in Jig's own content, which keeps the origin-reference
boundary and keeps one organization's evidence out of another's session. A
person files each repository's item with `jig reconcile file`.

`/jig:jig`'s "what changed, and what do I need to do" row points at
`/jig:reconcile` and `jig reconcile` in place of "read `CHANGELOG.md` at the
tag". Its description and routing table are re-checked against the new
check, as the plan item says, and the "which version is installed" row keeps
`jig doctor`.

### Where the audit fits

The check and the audit read the same things and answer different questions.
The audit scores a repository against module criteria and lists the
configuration fields added since its last record. This check says which
specific changes a repository owes. They share evidence, not code paths: the
check imports the audit's configuration-fit read and `config-schema.yaml`'s
`since` and `deprecated`, so a new key is reported once. The audit stays the
place a person sees maturity; this stays the place they see what a release
asks. Neither runs the other.

### Why not the alternatives

- **Only the last audit record as the baseline.** Records go stale, and the
  audit does not run on a schedule; the field is the repository's statement
  and is read in one place. The audit record stays a fallback.
- **A machine-only record.** It differs per host, is lost with the host, and
  cannot say what the repository has taken. It stays as a cache of what was
  reported and what needed nothing.
- **A mode of `jig doctor`.** Doctor is offline, fast and changes nothing; the
  check reads a repository and files. Doctor prints the count.
- **A mode of the audit.** The audit scores maturity against a profile and is
  heavy; this runs unattended every hour.
- **Matching prose by meaning.** It would produce misses that read as "not
  applicable". A note author names the phrase.

The decision to record the version in the repository is written down as an ADR
in the first build step.

## Build order

One pull request per step, each shippable alone:

1. **The note form and the record.** The `**Consumer action:**` and
   `**Detect:**` grammar and ids, the changelog check's validation and its
   `changelog.consumer_actions` setting, the `changes/README.md` section, the
   release step deriving `plugin/consumer-actions.json` with its freshness
   check, and the decision record (ADR-0015) for `jig.reconciled`. Done when a
   fixture note with each form passes, a malformed one fails, a Breaking entry
   without an action fails only where the setting is on, and the derived
   record matches the notes.
2. **A replay, then the check.** First a measurement: write the actions of one
   past release by hand, as notes would have, run the report against two
   repositories a person names, and confirm it finds the entries a person
   found by hand. A person decides whether the hints a note author writes are
   enough. Then `jig reconcile` and its report, the `jig.reconciled` field in
   the configuration schema, the baseline, the derivations, the read rules and
   masking, and the `file` form with its marker search. Done when a fixture
   repository and a fixture record produce one required, one advised, one
   needs-a-look, one dismissed and one not-applicable entry with evidence,
   `file` files nothing without `--entry` and never twice for one marker, and
   the replay's result is written in the pull request.
3. **The dispatch stage and `jig doctor`'s line.** The `reconcile` stage with
   its clone, bounds, record and once-per-id notification, and doctor's line.
   Done when a tick notifies once for a new required id, not again on the next
   tick, and again only for a later id; a stage over its time reports a
   timeout; and no other stage is delayed.
4. **The skill, `/followup` and `/jig:jig`.** `/jig:reconcile`, the arm's
   change, the `/jig:jig` re-evaluation, and the audit's note that this check
   exists. Done when the arm runs without asking which repositories are
   affected and `/jig:jig` no longer sends a reader to read the changelog by
   hand.

How it is judged: after step 3 has run for a month, the plan item is judged on
how many required actions a repository took within a week of the notification
and how many entries stayed in needs-a-look; those figures decide whether
hints need more structure. They are read from the machine record.

## Left out

- **Editing a consumer repository from Jig's side.** The check reports and
  files; the repository's own drive makes the change.
- **Filing without a person.** A standing approval in the machine file, so the
  stage files items itself, is not built. It would turn each release into an
  item, a drive and a pull request in every repository. It is reconsidered
  only after step 3 has run and the figures above show the report is read.
- **Project-scope plugin installs.** Issue #565 owns them; the
  `plugin-source:project-scope` hint reports one when #565 lands the way to
  read it.
- **Releases before the record.** Their entries are not read.
- **Guessing prose drift.** A repository's instructions drifting from Jig's
  behaviour with no note naming a phrase is not detected.
- **Signing the record.** The record travels in the plugin; a plugin copy a
  person can edit is outside what Jig defends.
- **A resident service.** The stage is a tick, not a daemon
  ([ADR-0013](../docs/adr/ADR-0013-records-not-a-daemon.md)).
- **Checking one repository on several hosts without duplicates.** The stage
  runs on one host per repository; the marker search keeps the filing from
  duplicating.

## Review

Red-teamed on 2026-11-07 in fresh context by four personas (critical chief
technology officer, security auditor, performance engineer, cost optimizer)
against the design as first drafted on `a8e16188`: all four returned
`revise`. Every finding is settled in the text above.
