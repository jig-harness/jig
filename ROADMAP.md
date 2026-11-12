# Roadmap

What Jig plans to build, in priority order. Each item says what a team that
uses Jig will get; how it is built, and the work only Jig's own maintainers
need, is in [the plan](design/plan.md), under the same numbers.

This page lists open work only. When an item is finished it leaves this page,
and what changed is recorded in [CHANGELOG.md](CHANGELOG.md).

## Now

First comes what lets a team's pull requests reach merge-ready with nobody
watching. An agent working alone cannot get past a person, the dispatcher
leaves no work stranded, and a person sees and steers the work from one
place.

### 40. The pass trust boundary as mechanisms

An agent that works one round of a pull request's review with nobody
watching, a [drive pass](plugin/MECHANISMS.md#the-two-kinds-of-part),
usually uses the login of the person who started the drive. Only its
instructions stop it from a few things it must never do. It could answer a
question it left for a person, push while a person holds pushes, or merge.
It could also loosen a check, resolve a review thread nobody answered, or
edit the records the dispatcher reads and the plugin copy its timers run.
Each of these gets a mechanism that runs instead: a hook, a permission rule
or a credential of its own. The
[mechanism map](plugin/MECHANISMS.md#where-the-boundary-rests-on-instructions)
then names what holds each one, or records its risk as accepted.

### 33. The dispatcher: a tick that starts the execution line's stages

A small program on the machine that runs the agent sessions starts each
stage of the execution line that should be running and is not: a session
that picks up an item assigned to the team's
[factory identity](GLOSSARY.md), a restart of a review drive stopped by a
usage limit (on another account) or by a question a person has answered,
a review drive restarted on a converged pull request that has since come
to conflict with its base or been pushed to, and the follow-up after a
merge. Pull requests that touch an area the repository marks as contended
(a migrations folder, a schema) are driven one at a time, the one closest
to merge first. It runs every few minutes, reports what it
would start and why before it is allowed to start anything, caps the
sessions per subscription account (Claude Code's or Codex's, the account
choosing the agent a session runs in), and reaches a person on their phone for
the decisions that are theirs. It never merges. Every finished session
leaves a row in an [outcome log](GLOSSARY.md) that one dashboard filters
by time, repository, stage, account and outcome; a session that falls
behind what its stage should achieve is reported as
[drifting](GLOSSARY.md), never corrected on its own; and the one prompt
it sends a session by itself is "continue", once a usage limit has reset.
Orca is its first session runtime
([ADR-0011](docs/adr/ADR-0011-the-dispatcher-targets-orca-first.md)),
with others through the same interface.

### 50. What the line hands a person: each class of need settled at its source

Most waits the dispatcher hands a person are not decisions. A flaky check
spends the drive's repair passes. A session ends without recording what it
did. Finished work sits in a pull request nobody linked to its item. One
host fault arrives once for every repository it touches. Each kind of wait
gets one place where it is settled. A mechanism stops most of them before
they start. The dispatcher settles the mechanical rest by fixed rules, and
the [steward](GLOSSARY.md) settles what needs reading, where a host allows
it. What reaches a person arrives as a decision with options, answered in a
word. A host fault arrives once, saying what to fix. Decisions that are a
person's stay a person's.

### 36. The dispatch board: what is driven and what is ready to merge

The dispatch dashboard leads with a Ready to merge list of the converged
pull requests a person can merge now. Each has a merge command that refuses
a pull request changed since its review. A pull request with a known approval
need stands beside them, naming requested reviewers or saying nobody was asked.
Its card says other merge rules remain unread and the forge may require more.
A pull request is ready only when the forge itself confirms its review, and an outside contributor's always needs a person's approval. Every
pull request shows the same status at a glance: conflicts, checks with the
failing ones named, unresolved review threads, and whether it is ready, with
the reason when not. Every card says whether it settles by waiting or waits
on a person. A person is told once when a pull request becomes ready, and
the history shows how long ready work waited and how much was lost to
waiting. Then the page places every piece of work the dispatcher knows,
whoever drives it: coming, picking up, driven, needs you, ready to merge,
or merged. Work moves in any direction, and a pull request
that was ready and moved back says why. Merging stays a person's.

### 39. Addresses: asking and telling the stations of the line

Every station on a piece of work has an address, such as
`drive@jig#456`: the drive of pull request 456. `jig ask <address>` says
who holds the station, what state it is in and what it waits on. It also
shows what was said to the station and by it. It reads the tracker, the
pull request and the dispatching machine's records.
`jig send <address> <verb>` writes the assignment, label, comment or
mailbox directive the line already acts on, from a closed list of verbs,
and checks first that the station can take it. The operator skill,
`/jig:operator`, turns a question such as "what is waiting on me" into
those commands. Nothing new is stored, and no agent has to keep running for an
address to answer.

### 46. Structured answers: approving or choosing a parked decision in a word

When a drive stops for a person, it frames the decision with its options
and the one it recommends. A person will answer `approve` to take the
recommended option, or `choose` and an option's name to take another. They
can answer from a terminal, the dashboard, the Orca panel or the forge on a
phone. The next pass gets the chosen option itself, not words to
interpret, and an answer in a person's own words still works as before.
Every answer line Jig offers carries a short code for the version of the
decision it answers, so an approval of an older version does not count.
On the dashboard a person moves to a card with `j` and `k` and
presses `1` to pick the recommendation. A pick stays on the page and can be
undone, and one comment can answer all of a pull request's decisions.
Everything else the line waits on a person for comes framed the same way.
A follow-up or a pickup that stops frames its own question. For what the
dispatcher finds itself, such as a failed follow-up, a stalled pickup or a
stopped drive, it offers the steps it can take. It takes the one a person
chooses, once.
Jig also reports how often each kind of decision follows the
recommendation, so a team can see which decisions still need a person.
Later, decisions that cannot be undone, such as a release, will need proof
that a person answered.

### 42. The dispatch dashboard: one place to watch and steer the line

One page shows a person every piece of work in flight, across the machines
that run it. A piece of work is a tracker item, the pull request it opens
and that pull request's follow-up, on one card. The page, the
[dispatch dashboard](GLOSSARY.md), opens on what is safe to merge, else on what waits for
that person. It shows what runs and what is queued, and opens any piece of
work end to end, with its correspondence. A card shows the drive's round and how long it has run, and
which review threads wait on a person rather than a bot. A pull request held
back from CI on purpose reads held, never failing. A pickup shows its
progress before its pull request exists. The dashboard reads the records the line
keeps and stores no copy of them. On a host, the dashboard only reads and accepts
no commands. A laptop serves the page to any browser, and shows every
host when the team runs the hub (item 49). Every view works without Orca. A team that uses
Orca opens the dashboard in Orca's own browser. A phone reaches a host's page
through a front on a private network. Phone access is required, with read-only
views, visible copy controls and links to pull requests and issues. Tailscale
Serve is the first such front. The front names who is looking and shows each person only their
own repositories. A chat with the [operator](GLOSSARY.md), the agent a
person asks about the line, explains why work is stuck and drafts what to
do. A person confirms every action, and the words of an answer are always
theirs. A person answers a parked decision from the page with Send, which
posts from their own browser with their own GitHub token; the host never
writes. Every other write from the dashboard waits until it can show that a
person made it. The first stage puts each pull request's status on the dispatch
dashboard a team already runs. A person decides on the rest once that stage
is in use.

### 34. Jig in the Orca ecosystem

[Orca](https://www.onorca.dev) is one of the workspace runtimes Jig's
tooling supports, beside Herdr, the runtime it targets first. A small
plugin Orca loads runs a dispatcher tick the moment an agent stops or
waits. On an Orca host the plugin will also refuse to start an agent in a
worktree `jig gc` is removing, for every launch Orca makes through its
launchers, so a launch gc's last check could miss is turned away. The
protection is best-effort: a restored session, a hook that fails and a
plugin that is down are not covered. The plugin will show what waits on a person in Orca's
status bar and in a panel. The panel opens on that person's inbox, and a
command opens the dashboard in Orca's own browser for the board and each piece of
work. The dispatcher will read each account's usage
from Orca's command line once Orca offers it. The plugin is Orca-bound.

## Next

Next comes delegated merge, once an agent cannot push or merge by any other
path. Then come what lets a second team adopt Jig, one control plane for a
team on several machines, work that arrives complete, and reviews that
catch what checks cannot. Last come the practices
the modules and skills lack, measurement, the developer machine and its
runtimes, and the runs that wait on a person.

### 9. Delegated merge (`pull_requests.merge: auto-on-converged`)

An opt-in setting that lets a converged drive arm the forge's auto-merge for
the exact commit it certified, for a repository that chooses to delegate the
merge. The delegation is read only from places the pull request cannot
change, and withdrawing it withdraws an auto-merge already armed. It waits
until [the pass trust boundary](#40-the-pass-trust-boundary-as-mechanisms)
holds, so an agent that may arm a merge has no other way to push or merge.
Jig itself keeps a person merging
([ADR-0003](docs/adr/ADR-0003-a-person-merges.md)).

### 47. A repository's own rules for starting, reviewing and finishing work

A team states the rules its agent work follows, and every Jig skill that
claims, moves or closes an item keeps them. Work starts only when a check
the team supplies passes and only from the states the team allows, and the
dispatcher can pick up from an unassigned ready pool. Every rule is
optional, and a team that sets none keeps today's behaviour. The rules are
built; what remains is proving them on a team's own Jira project, from its
ready pool to a merged pull request.

### 48. Fitting the drive to a repository's reviewer

Some AI reviewers, CodeRabbit for one, write findings in the text of their
review rather than as comments on lines. The drive reads those findings too,
so it never finishes with them unanswered.

### 49. The hub: one control plane for many dispatchers

A team or a person who runs the dispatcher on several machines can add one
service that every host calls, the [hub](GLOSSARY.md). It reads the forge
and the tracker once for all the hosts instead of once per host, so their
rate limits are spent once. Its claims let several hosts pick up one
repository's work, and it tells a person when a host stops. It shows every
host's work on one dashboard, phone included. Later it offers work to
whichever host has a free slot, in an order each team can set. The hub
runs on a machine the team chooses and needs no cloud service. Nothing
requires it: a host that does not enroll, or whose hub is down, dispatches
on its own as it does today.

### 26. `init`: setting a repository up for Jig

One command in a fresh clone that derives the values the repository already
states (gate command, integration branch, reviewers, issue-key prefix,
catalog, changelog), asks only what it cannot derive, writes
`.config/jig.yaml` with the evidence beside each value, enables the plugin
for everyone who clones, and checks the result the way the audit will. The
audit stays the measurement; init is the setup, and the audit's remedy for a
fixable configuration finding.

### 3. The kickoff family

A `kickoff` skill that starts a new repository from nothing: requirements,
architecture, an adversarial review of both, the repository and its
[scaffolding](GLOSSARY.md), implementation plans and the first tracker
issues. It replaces the fixed starter kit the
[greenfield guide](adoption/greenfield.md) uses today. With it come plan
review inside `review`; and `upgrade-deps`, which makes grouped dependency
upgrades an update bot cannot make alone and drives them to merge.

### 8. The audit experience: what is left

An audit at the end of a greenfield kickoff that checks the chosen
[profile](profiles/README.md) first and leaves out the modules outside it;
and the audit results a team marks as wrong reaching the
[reflection store](plugin/skills/reflect/README.md), so the audit learns
from them.

### 38. One look for Jig's pages

The pages Jig's tooling draws will share one look: the dispatch dashboard,
the decision, explainer and audit sheets, and the code-stats report. Each
will follow the reader's light or dark setting and carry Jig's mark as its
icon. Every text colour will meet WCAG AA, the Web Content Accessibility
Guidelines' minimum contrast, in both modes.

### 41. Configurable issue attributes: type, priority and size

Every issue records its type, priority and size (an epic needs no size), so a
team can sort and filter its tracker by them. A team chooses where its
tracker keeps each one: the tracker's own field, a custom field or labels.
Each tracker Jig supports has a documented default. On GitHub Issues that is
the issue type and the organization's own issue fields, for a repository that
does not already keep them in labels. No repository's store moves unless it
asks. Every way Jig's tools file an issue through the tracker sets all three
(an epic needs no size) and checks them. The issue forms set the type and
leave priority and size to triage. The weekly check can move an issue missing an attribute back to
triage while it has not been started, or only comment on it. Jira's
issue-type and custom-field stores and Linear's estimate are built; still to
come are live checks of those stores. Also to come: an epic recognised by its
issue type as well as its label.

### 43. Consumer actions: which Jig changes a repository must act on

A Jig release can ask something of the repositories that use it: a runbook
that describes old behaviour, a configuration key to change, a plugin source
on a machine. A repository records the Jig version it last took. One
command, `jig reconcile`, checks the repository against every change since
that a release note says it must or should act on. It checks each host against
the changes that concern it. It reports what the repository must do, what it is
advised to do, what needs a person's look and what does not apply. Each line
names the file and line that show why. It files items in the repository's own
tracker only for what a person approved. A dispatch stage runs the check for
each repository a machine drives and tells a person once for each new required
change.

### 12. More tracker adapters

A plan file kept in the repository, beside Linear, GitHub Issues and
Jira. The [tracker interface](GLOSSARY.md) first gains attaching a file,
the one operation the skills need that the interface does not have yet.

### 27. Work types: depth by kind of work

An item's type (bug, feature, improvement, task, spike) derived from the
tracker's label taxonomy, its own issue type or a conventional title prefix,
and one table saying what each type changes: pre-scouts, test-first, review
tiers, the change note, batchability, autonomy. A type lightens the work
only where no flag label, catalog review or gate asks for more, and an item
whose type is unknown gets the deepest treatment.

### 29. The spec a work item links

A work item names where its requirements and acceptance criteria live, in
its own body or in whatever spec framework the repository already uses, and
Jig resolves that reference read-only, through an adapter per layout, into
requirements, acceptance criteria and tasks with their ids. The implementing
agent and the reviewer get the list, and the pull request accounts for every
criterion: met with evidence, deferred to a filed item, or not applicable.
The delivery loop writes no spec and dictates no format; the tools that
write specs well are recommended beside the adapter that reads each.

### 31. Routing work to an agent, a model and an effort

Delegation already picks an agent from the issue's change areas, labels and
title, and `do-item` reports the complexity tier, the model and the effort
the work's type, its size and flag labels and the change areas' mandatory
reviews call for, with Claude's and OpenAI's model families known, by
rules a repository declares with defaults it overrides. The agent still
runs on whichever model and effort the session was started with, whatever
the work. Routing will apply that route to the implementer, opt-in, with
the reason recorded on the pull request where the review loop's reports
join it to the outcome, and a person's choice always able to override it.
Until then, the workspace launcher's Orca provider hands the agent's start
to the person; its Herdr provider starts the configured agent.

### 23. Seed review lenses

[`review`](plugin/skills/review/SKILL.md) runs [review lenses](GLOSSARY.md)
from one file each, and ships the lens for no swallowed failure
([M15](modules/M15-contracts-errors/README.md)); the other rules Jig's
modules state that no gate can judge have none yet. Still to come: a test for
each changed behaviour ([M14](modules/M14-testing-strategy/README.md)),
comments that say what the code does now ([M4](modules/M4-docs-governance/README.md)),
and types that admit no invalid value (M15). Each runs only when the diff
gives it something to check, comments until measurement shows it may block,
and can be loaded by a repository's own automated reviewer.

### 30. Scanner findings block convergence

A static-analysis app that reports to the pull request as annotations rather
than review threads (SonarQube Cloud does) has its findings worked by the
review loop when a round runs, but a drive with only annotations can converge
without starting one. They will count as open work beside threads and summary
findings; a finding that stands can be recorded against the head so a later
head is checked again; and the tool's own dismissal is made where the tool
offers one.

### 25. Dependency-review feedback

Tools that review a pull request's dependency changes for supply-chain risk,
such as Socket, report in a check and a summary comment. The review loop
already counts a failing check of theirs in its CI verdict, like any other
check, but does not read their alerts. The loop will read their alerts as
findings with a severity, answer or fix them like any other finding, and show
their scores without acting on them. A failing check of such a tool will not
stop a pull request by itself, unless the repository requires that check; its
alerts will.

### 17. Corrected designs for the existing modules

Practices working repositories validated, added to the modules that exist:
watchdogs for what is deployed (M10, M11), an acceptance stage (M6), a skill
that runs M7's post-merge stage in any repository, and a generator for the
model roster (M0).

### 10. Values the skills still assume

A few values are still fixed in the skills rather than read from
[configuration](plugin/CONFIGURATION.md): the review skill's follow-up step
calls Linear directly with fixed label groups, so a repository on GitHub
Issues, the default tracker, cannot yet defer a review finding, and some
skills outside the delivery loop still assume a git remote named `origin`
where the rest read [`repository.remote`](plugin/CONFIGURATION.md#repository). They move
into configuration, and the follow-up step onto the tracker interface, so it
files on every tracker Jig supports.

### 20. `code-stats`: a reference set and audit evidence

The [code-stats skill](plugin/skills/code-stats/README.md) is checked
against a recorded set of public repositories in several languages, and gives
[`jig:audit`](plugin/skills/audit/README.md) measured evidence: the test to
code ratio, the generated share and the size of the agent scaffolding.

### 21. `changelog` skill: several artifacts

A repository that releases several things at their own versions, such as a
monorepo's packages, keeps a changelog and a version for each with the
[`changelog` skill](plugin/skills/changelog/README.md), as
[M16](modules/M16-releases-versions/README.md) asks; today the skill keeps
one per repository. The skill also gets workflow templates for CI providers
other than GitHub.

### 28. `verify` and `debug`: evidence before claims, and a bounded debugging protocol

`verify` runs a check and keeps the proof: the command, the tree it ran
against, its exit code, the test counts from the runner's own report, and
the output's head and tail, so a pull request's "tests pass" points at a
record and a new test's failing run is recorded before its passing one.
`debug` works one failure whose cause is not obvious through a fixed
protocol: reproduce, attribute on a fresh base, narrow, write down each
hypothesis, fix, and stop after a stated budget with the ledger posted where
the work is tracked, instead of a fourth guess.

### 24. Resource garbage collection for a developer machine

One command, `jig gc`, that reports and then reclaims what parallel agent
worktrees leave on a machine: fixture processes, scratch directories,
container volumes and images, merged branches and tool state. Every kind
follows one contract (something must prove the resource dead, age only
guards, report first, fail closed, a receipt per run); a repository enables
the kinds it mints with its own facts, a machine sets the schedule, and
[M12](modules/M12-parallel-agent-ergonomics/README.md) gains the practice.

### 19. Herdr as the primary workspace runtime

[Herdr](https://herdr.dev) is the [workspace runtime](GLOSSARY.md) Jig's
tooling is built and tested for first
([ADR-0005](docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)).
Opening a tracker issue as a Herdr workspace, on the machine or on a remote
host, and M12's worktree lifecycle in Herdr are available
([the Herdr workspace tool](tools/herdr/README.md)); what remains is checking
the drive, pickup and review skills inside Herdr on macOS and Linux. That
check waits on a repository that runs its agents in Herdr.

### 7. The Notion store, verified against Notion

The [Notion store](plugin/skills/reflect/README.md#notion-store) for
reflections passes its tests against a stand-in for Notion's API. This item
runs it against Notion itself and fixes what differs. That run waits on a
person with an access token for a Notion workspace.

### 45. Distribution: a common setup entry point

A common setup path checks the machine and explains missing prerequisites
before installing Jig through the agent tool's marketplace. It preserves the
source and version pin a team selected. The first build covers macOS, Linux and
Windows; an own Homebrew tap is considered after that path is validated.
Other catalogs wait for evidence that Jig's components and updates work there.
See the [distribution design](design/distribution.md).

## Later

- **Scheduled-failure reconciliation.** A reusable reconciler for
  [M11](modules/M11-process-observability/README.md)'s scheduled failures,
  on the tracker interface: one issue per cause, bounded recurrence comments
  with announced suppression, and automatic closure on confirmed recovery.

- **Jira store for reflections.** Reflections kept as Jira issues, for a team
  that tracks its work in Jira.
- **A repository's theme.** A team gives its pages an accent colour and a
  mark of its own. Jig derives the other colours, so the pages stay
  readable in light and dark.
- **More skills.** `scaffolding-update`, which keeps agent instruction files
  in step with decisions and audits them
  ([M0](modules/M0-instruction-architecture/README.md)), and a review skill
  for SOLID design principles.
- **Tracker planning.** Epic planning and prioritisation as skills on the
  tracker interface.
- **A forge interface.** GitHub is the only forge the pull-request skills
  work with; an interface with GitHub behind it, then GitLab as the second
  ([what it covers](plugin/EXTENDING.md#forge-github)).
- **CI logs from other providers.** `fix-ci` downloads a failed run from
  GitHub Actions only (any CI's saved log already works with `--log`).
- **Windows for `drive-pr` and `do-item`.** Complete the authenticated
  pickup, draft pull request, drive round and stop acceptance run under
  Claude Code and Codex with PowerShell.
- **Drive loop follow-ups.** A drive's CI-repair round running `fix-ci`,
  through a `fix-ci` mode that stops before pushing so the drive does the
  push itself.
- **Gates and workspace infrastructure.** Locks shared across
  worktrees, remote gates, and a runnable form of
  [M12](modules/M12-parallel-agent-ergonomics/README.md)'s workspace
  lifecycle for runtimes other than Herdr and Orca.
- **Orca: what is left.** The [Orca workspace tool](tools/orca/README.md)
  opens and removes worktrees and the launcher opens issues in Orca, on a
  machine or on a paired Orca server. Still open: an agent's start recorded
  on the server rather than on the launching machine, so two machines never
  start it twice; reflection findings parked on a server's host before a
  removal, which today refuses while unsent ones are there; hooks on a
  server's host supervised as they are on a machine; the drive, pickup and
  review skills checked inside Orca worktrees on a server, as item 19 does
  for Herdr; and the tool and the launcher's Orca provider on Windows, where
  the tool's host steps (`sh`, `test`, `mkdir`) need the host's own shell
  first.
- **The mailbox as every session's inbox.** Open the drive mailbox to every
  session the execution line starts once a second mechanical nudge needs it.
- **Change-area consumer lint.** The
  [change-areas skill](plugin/skills/change-areas/README.md) checks the path
  lists in agent rules, hook configuration and CI workflow triggers against
  the catalog, so a copy of an area's globs fails when it drifts.
- **The resolver in the delivery skills.** A repository with a change-area
  catalog and no validation-plan command gets its plan from the catalog in
  `drive-pr` and `fix-ci` too, as `review` already does for its mandatory
  reviews.
- **Bun's linter and formatter.** A linter reports code that breaks a rule;
  a formatter rewrites code into one consistent layout. Bun is adding its
  own, `bun lint` and `bun fmt`, which could replace Biome (one tool that
  does both, which Jig uses for its TypeScript and JSON). Evaluate them once
  they ship in a stable Bun release.
- **Standalone reference gates.** Reference gates a repository can copy one
  at a time.
- **Module gaps.** The items each module README lists as future.
