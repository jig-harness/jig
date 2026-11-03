# Jig's voice

How to write Jig's visitor pages: who reads them, how the writing sounds,
what never appears on them, and passages rewritten to show the difference.
A page written to survive review reads like a reference. Every exception sits
inside its sentence, and every mechanism has its name. Roadmap numbers and
configuration keys sit in the story. A reader with ten minutes then leaves
without knowing what Jig does for a team.

## Where it applies

Visitor pages are the pages a reader meets first:
[README.md](../README.md), [FACTORY.md](../FACTORY.md),
[FEATURES.md](../FEATURES.md), [ROADMAP.md](../ROADMAP.md), and the copy
written into the site's own pages and components (`website/src/`). The banned
list below applies to them.

Reference pages keep their density: the modules, the skills, the glossary,
the configuration reference, the principles. They serve a reader who wants
the exact rule. The voice below is the aim there too, and the banned list
does not bind them.

The site renders the visitor documents. A fix goes into the document, never
into the site alone ([Which document wins](README.md#which-document-wins)).

## The readers

- **The evaluator.** An engineer or a lead who decides, in ten minutes,
  whether a team should use Jig. They know agents and pull requests, and none
  of Jig's words.
- **The adopter.** A maintainer who sets Jig up in a repository and wants
  the exact rule.
- **An agent.** A coding agent sent to the site. It reads the Markdown copy
  the site serves beside each page.

Visitor pages serve the evaluator. Reference pages serve the adopter and the
agent.

## The voice

These passages set the voice. The maintainer may replace any of them with a
passage that sets it better, and the description below then follows the new
one.

> Some of Jig's parts are programs that run the same way every time. Others
> are an AI model reading instructions and deciding. A team that adopts Jig
> needs to know which is which.

The opening of the [mechanism map](../plugin/MECHANISMS.md). A fact, its
contrast, and why the reader cares, each in a short sentence.

> Nothing needs restarting after a night: the timer ran every tick.

The morning routine of [the dispatcher](../plugin/README.md#the-dispatcher).
The reader's worry comes first, then the mechanism that settles it.

> Two pull requests never edit the same lines, so merging one does not put
> the others in conflict.

The changelog feature of
[FEATURES.md](../FEATURES.md#change-notes-and-a-changelog-nobody-fights-over).
A boundary stated as an absolute, then the consequence a team feels.

What they share:

- A sentence says what happens, who does it, and what it leaves behind.
- The actor has a name: a person, an agent, a session, a skill, the
  dispatcher.
- A boundary is short and absolute: "A person merges."
- A number that constrains stays. A number that counts the list beside it
  goes, or a check derives it.
- A workshop image appears once, to name a thing, and goes no further.
- The tense is the present.
- The home page and the adoption pages say "you". Every other page names a
  generic actor: a team, a maintainer, an agent.
- No adjective sells.

## Banned on visitor pages

- A roadmap item number in a sentence. A feature's "On the roadmap" field
  and the roadmap page say what is open.
- A configuration key or a file path in the running text. Link the page that
  documents it.
- A term of art before its plain meaning. Say what the thing does, then give
  its name and link the glossary.
- A sentence over 30 words.
- Two semicolons in one sentence.
- A parenthesis that holds more than three items.
- "Today", "so far", "not yet" or "still" as a marker of time.
- "Leverage", "seamless", "robust", "powerful", "best-in-class".
- A rhetorical question as a transition.
- An aside between dashes where a sentence of its own would do.
- The passive voice where the actor is known.

## What the check counts

The [quality gates](../GLOSSARY.md) run
[`scripts/check-voice.ts`](../scripts/check-voice.ts) over the visitor
documents. It runs the `decide` skill's
[Simplified Technical English](../GLOSSARY.md)
[linter](../plugin/skills/decide/scripts/ste-lint/README.md), a program that
checks prose against that standard's rules, under this guide's caps. Each of
these is one finding:

- a sentence over 30 words
- a sentence with more than one semicolon
- a match of the linter's word rules: a phrasal verb, a marketing adjective
  it knows, an action frozen into a noun, a list item that ends on "and" or
  "or"

The check reports passive voice as advice and never counts it. The other
bans need a reader, so the writer and the reviewer hold them.

The check keeps no baseline file. The [ratchet](../GLOSSARY.md) in
`bun run quality` counts each document at the
[merge base](../GLOSSARY.md) and in the change, and refuses a change that
raises a document's count. A count may fall in any
change. A refusal names the document and quotes each new sentence.
`bun scripts/check-voice.ts --list FACTORY.md` lists every finding of one
document, with its sentence.

## Before and after

Each pair shows a passage written for a reviewer, then the same facts written
for a visitor.

### A bullet that carries every list

Before:

> - **Fitted to how the organization works.** Jig is modular, configurable
>   and extensible:
>   - modules adopt one at a time, and none requires another's strictest level;
>   - an organization's own values (its gate command, reviewers, tracker team
>     and labels, pull-request policy, change-area catalog) live in
>     configuration, in layers for the person, the repository and the single
>     run, rather than in the skills' code, and the audit checks that
>     configuration against the repository; the values the skills still assume
>     (fixed tracker label groups in the review skill's deferral step, a remote
>     named `origin`) are listed in ROADMAP.md item 10;
>   - …

The second item is one sentence with two semicolons and a parenthesis of
more than three items. It cites a roadmap number, marks time with "still", and names the
change-area catalog with no plain meaning.

After:

> **Fitted to how the organization works.** A team adopts one module at a
> time, and no module needs another at its strictest level. The
> organization's own values come from configuration: the command that
> runs its checks, its reviewers, its issue tracker's team and labels. The
> skills read that file when they run, and the audit checks it against the
> repository.

What the skills assume moves to the roadmap page, with the other open work.

### A feature that names every mechanism

Before:

> `file-issue` puts the work item on the issue tracker first: a body that
> still holds once the code moves, labels from the repository's label
> taxonomy that are checked before anything is written, and a search for a
> duplicate. `do-item` picks up one work item from the issue tracker,
> implements it, opens a pull request the way the repository's pull-request
> policy says, and starts `drive-pr`, which runs the review rounds unattended
> until the pull request reaches one named end state (converged, waiting on a
> person, conflicting, …).

The paragraph opens on a skill's name before the reader knows what a skill
is. Its second sentence chains every step and ends on a parenthesis. "Label
taxonomy" and "pull-request policy" arrive with no plain meaning.

After:

> An agent takes one work item from the issue tracker, builds it and opens a
> pull request. The review then runs with nobody watching. Each round is a
> fresh agent, which gives every open review thread an outcome: a fix, or a
> reply that says why not. The rounds stop when the pull request is ready or
> needs a person. A person merges.

The skills' names move to the feature's "Skills" field.

### A headline that opens on a term of art

Before:

> Scaffolding that lets AI agents work your repository well — adopted one
> module at a time.

The first word is Jig's own term. The reader learns no problem, and "well"
promises nothing a reader can check.

After:

> Agents open pull requests faster than a team can review them. Jig checks
> each change before the push, then runs its review rounds with nobody
> watching. A person merges. Adopt it one module at a time.
