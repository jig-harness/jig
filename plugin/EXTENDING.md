# Extending and adapting Jig

A team that adopts Jig rarely uses exactly the tools Jig's tooling is bound
to today. Without a map of what can change, it finds out by trial: it sets a
field that does not exist, writes a wrapper around a skill that already
takes a command, or discovers halfway through a drive that its forge, its
issue tracker or its operating system is not supported. This document is
that map. It says which parts of Jig a repository adapts with a value,
which with a command of its own, which need an implementation added to Jig,
and which are fixed today, with the [roadmap](https://github.com/jig-harness/jig/blob/main/ROADMAP.md) item that
would open each one.

Every field it names that exists today is in the
[configuration reference](CONFIGURATION.md). What a machine needs is in the plugin's [requirements](README.md#requirements).

Contents: [ways to adapt](#ways-to-adapt-jig) ·
[at a glance](#at-a-glance) ·
[commands a repository supplies](#commands-a-repository-supplies) ·
[the repository's own skills and agents](#the-repositorys-own-skills-and-agents) ·
[issue tracker](#issue-tracker) · [reflection stores](#reflection-stores) ·
[AI reviewers](#ai-reviewers) · [forge](#forge-github) ·
[CI system](#ci-system) · [agent tools](#agent-tools) ·
[workspace launcher](#workspace-launcher) ·
[operating systems](#operating-systems) ·
[practice mappings](#practice-mappings) ·
[contributing an extension](#contributing-an-extension)

## Ways to adapt Jig

From least to most work:

1. **Set a value.** Labels, team keys, branch patterns, reviewer names, file
   locations: the repository writes them in `.config/jig.yaml`, a person in
   `~/.jig/jig.yaml`, one run in an environment variable
   ([configuration layers](CONFIGURATION.md#configuration-layers)). Many
   values need no field at all, because Jig reads them from the repository
   ([what is derived](CONFIGURATION.md#what-is-derived-not-declared)).
2. **Supply a command.** Where the work is the repository's own (its checks,
   its generators, its lints), a skill runs a command the configuration
   names, under a fixed contract: what it receives, what it prints, what its
   exit code means. Any language, any tool; nothing in Jig changes
   ([below](#commands-a-repository-supplies)).
3. **Add an implementation behind an interface.** Where Jig talks to an
   outside service (an issue tracker, a workspace app), it does so through
   an interface with one implementation per service, chosen by a field. A
   new service is a new implementation, added to Jig by pull request, so
   every repository that uses that service shares one maintained copy.
4. **Add to the doctrine.** Each module's `mappings.md` names the tools that
   implement its practice in each ecosystem. A tool missing there is a new
   row ([below](#practice-mappings)).

What a repository should not do is copy a skill to change it: the copy stops
receiving fixes the moment it is made. When none of these fits, the gap
is Jig's: [contribute](#contributing-an-extension) the field, the command
hook or the interface instead.

## At a glance

| Concern                                    | Supported today                                                                                                                                                                                                                                                                                       | Adapt it by                                                                                                         | Fixed today, open in                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Local checks, generators, lints            | Any command                                                                                                                                                                                                                                                                                           | [A command](#commands-a-repository-supplies)                                                                        | —                                                                                                                       |
| Review skills, implementing agents, scouts | The repository's own                                                                                                                                                                                                                                                                                  | [Configuration](#the-repositorys-own-skills-and-agents)                                                             | —                                                                                                                       |
| Issue tracker                              | GitHub Issues (the default); Linear; Jira Cloud                                                                                                                                                                                                                                                       | [A tracker adapter](#issue-tracker) in Jig                                                                          | The deferral step still calls Linear directly: roadmap items 10 and 12                                                  |
| Reflection store                           | A folder of files, a Notion database, a GitHub repository's issues, or any command                                                                                                                                                                                                                    | [A store command](#reflection-stores), no change to Jig                                                             | Jira: roadmap, later                                                                                                    |
| AI reviewer                                | Any bot, by login, app and check name; finding severities from CodeRabbit, Greptile, the Codex connector, Jig's own finding format, or any reviewer [configured](#severity-formats); GitHub code scanning alerts from any tool, SonarQube Cloud's included                                            | [Configuration](#ai-reviewers)                                                                                      | —                                                                                                                       |
| Forge (where pull requests live)           | GitHub, through the `gh` command                                                                                                                                                                                                                                                                      | —                                                                                                                   | [No forge interface yet](#forge-github): roadmap, later                                                                 |
| CI system                                  | Any CI that reports checks to GitHub                                                                                                                                                                                                                                                                  | `ci.required_checks`; `fix-ci --log`                                                                                | [Log download and workflow review](#ci-system) are GitHub Actions only                                                  |
| Git remote                                 | Any name, `origin` by default                                                                                                                                                                                                                                                                         | [`repository.remote`](CONFIGURATION.md#repository)                                                                  | [`review`, `review-reflections`, `reflect`, `code-stats`, `changelog` and the audit](#forge-github) still read `origin` |
| Agent tool                                 | Claude Code, Codex                                                                                                                                                                                                                                                                                    | [Copying the skills](#agent-tools) for any other                                                                    | —                                                                                                                       |
| Workspace launcher                         | Linear and GitHub Issues; Herdr (the primary target) on macOS and Linux, locally or on a host over SSH; Orca on macOS and Linux, locally or on a paired Orca server; Conductor on macOS                                                                                                                                 | [A provider](#workspace-launcher) in Jig                                                                            | —                                                                                                                       |
| Workspace runtime                          | Herdr, through the [workspace tool](https://github.com/jig-harness/jig/blob/main/tools/herdr/README.md) and its plugin; Orca, through [its workspace tool](https://github.com/jig-harness/jig/blob/main/tools/orca/README.md); any runtime that creates worktrees and starts sessions, for the skills | M12's [hook points](https://github.com/jig-harness/jig/blob/main/modules/M12-parallel-agent-ergonomics/mappings.md) | —                                                                                                                       |
| Operating system                           | macOS and Linux; Windows for most skills                                                                                                                                                                                                                                                              | —                                                                                                                   | [`drive-pr`, `do-item` and the launcher](#operating-systems)                                                            |
| The repository's language and stack        | Any                                                                                                                                                                                                                                                                                                   | Practice mappings; Bun runs Jig's tools only                                                                        | —                                                                                                                       |

## Commands a repository supplies

Each of these is a field whose value is a shell command. The skill runs it
from the repository root and judges it by its exit code: 0 is success. The
contract column says what else the command is given or must print.

| Field                                   | Run by                                                               | Contract                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gates.command`                         | resolve-review-comments, drive-pr, fix-ci, resolve-conflicts, descar | The repository's complete local checks, run before every push                                                                                                                                                                                                                                                                                               |
| `drive.validation_plan_command`         | drive-pr, and the skills that verify a change                        | Reads the changed files, one per line, on standard input; prints the validation plan as JSON ([format](skills/drive-pr/README.md))                                                                                                                                                                                                                          |
| `drive.load_guard_command`              | drive-pr                                                             | Returns once the machine can take heavy checks                                                                                                                                                                                                                                                                                                              |
| `descar.lint_command`                   | descar                                                               | Takes document paths; finds review scars in them                                                                                                                                                                                                                                                                                                            |
| `promote_memory.lint_command`           | promote-memory                                                       | `{dir}` and `{file}` stand for the memory folder and file; checks one memory against the repository                                                                                                                                                                                                                                                         |
| `fix_ci.regenerate_commands`            | fix-ci                                                               | Each regenerates committed generated files a CI check compares                                                                                                                                                                                                                                                                                              |
| `ci.log_command`                        | fix-ci, for a drive's CI-repair pass                                 | Reads `{"context", "target_url"}` of a failing commit status as JSON on standard input; prints that status's failed log, at most 64 KiB. Runs in a temporary copy of the default branch's files, not the pull request's checkout. Exit 3, the reason its first output line, when the log is gone; 300 s                                                                                                                                              |
| `resolve_conflicts.generated[].command` | resolve-conflicts                                                    | Rebuilds the files its `paths` match when they conflict                                                                                                                                                                                                                                                                                                     |
| `explain.figure_build_command`          | explain                                                              | Builds one explainer figure; the figure's stem is appended                                                                                                                                                                                                                                                                                                  |
| `code_stats.classify_command`           | code-stats                                                           | Reads every tracked path, one per line, on standard input; prints one JSON object per line, `{"path", "area"?, "kind"?, "language"?, "module"?}`, whose values override the skill's own classification ([contract](skills/code-stats/README.md#the-classify-command)). Exit 0 within 300 seconds; any other exit, or a line it cannot use, fails the report |
| `do_item.preflight_command`              | do-item, work-batch and the dispatcher's pickups, through `tracker.ts claim` | Read from the default branch, and run without the tracker and forge tokens. Reads the item's `get_issue.ts` JSON on standard input. Exit 0 lets the claim go on; exit 3 refuses it and the first line of standard output is the reason; any other exit, more than 64 KiB of output, or a run past 60 seconds, refuses too ([contract](CONFIGURATION.md#do_item)) |

`issue_tracker.file_command` is different: no skill runs it. It is an
instruction that `do-item`, `decide` and others hand to the agent, saying how
to file an issue by hand, so it may be a slash command, and its exit code is
not checked.

The drive's pass is a command too: whatever follows `--` in its
[start command](skills/drive-pr/README.md#how-to-start-it) replaces the
default `claude -p`, which is how a drive runs on Codex or behind a wrapper.

## The repository's own skills and agents

Jig's skills hand parts of their work to the repository's own procedures,
named in configuration:

- **Review gates.** `do_item.gates` names a review skill that must approve a
  change before it is pushed, when the issue carries one of its labels or the
  change touches one of its paths. A change area in the
  [change-area catalog](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) names the review skills its changes
  need the same way.
- **Implementing agents and scouts.** `do_item.agents` routes an issue to one
  of the repository's own subagents by change area, label or title, and
  `do_item.scouts` names the scouts that run before each.
- **Rulings.** `decide.architect_agent` names the subagent that rules on a
  dilemma; `decide.policy_files` and `decide.rules_directory` name where the
  repository keeps its standing policy.
- **Decision rules.** `adr.rules_file` holds the machine-readable rules
  `review` checks a change against.

## Issue tracker

**Interface.** The skills reach the tracker through the
[tracker interface](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), defined in
[`do-item/scripts/lib/tracker/port.ts`](skills/do-item/scripts/lib/tracker/port.ts):
check that the tracker answers for the team or repository (the audit's
reachability probe, which reads no issue), read an issue with its comments and children, move it to a workflow state,
comment, file an issue, change its fields and labels, search this team's
issues, read and add relations between issues, list the labels an issue can
carry, attach a file to an issue and list, read or remove its attachments
(`tracker.ts attach`, `attachments` and `fetch-attachment`, in the form each
adapter below says), read whether an item is open (`tracker.ts issue-states`, which M4's
scheduled [deferral check](https://github.com/jig-harness/jig/blob/main/plugin/skills/docs/scripts/deferral-references/README.md)
uses), and the reads that delivery metrics and batch proposals need. Every
issue it reads and writes carries its
[issue facets](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), its
type, priority and size, as values that mean the same in every repository,
kept wherever `issue_tracker.facets` says
([CONFIGURATION.md](CONFIGURATION.md#issue_tracker)); a pool can be narrowed
by facet, one read lists the open issues not yet started that lack one
(`incompleteIssues`, which lists the started ones instead when asked),
another reads every open issue with its facets (`openPopulation`, which
the move between stores reads through a tracker of each store), and
another reports where each is kept (`facetStores`, `tracker.ts
facet-stores`); they take their caller's cancellation signal and deadline,
and start no further request or page once either stops them. Every filing
through `openTracker` is checked inside `createIssue`: one without a type,
a priority or a size is refused before anything is written, naming what it
lacks. A label a label store owns is the facet's to write: the
interface refuses it among the labels a filing or a change adds. Labels
and projects are given by name and a parent by its key; the adapter resolves
each to exactly one tracker resource or refuses before writing. A skill's
procedure runs the issue operations as commands of
[`do-item/scripts/tracker.ts`](skills/do-item/scripts/tracker.ts). States
are named by canonical keys (`in_progress`, `in_review`, …) that
`issue_tracker.states` maps to the tracker's own names.

**Implementations.**

- **GitHub Issues** (`github`, the default for `issue_tracker.adapter`;
  [`github/`](skills/do-item/scripts/lib/tracker/github/tracker.ts)), the
  issues of one repository (`issue_tracker.github.repository`, else the
  git remote's, `repository.remote`). It uses the signed-in `gh` command-line client. Keys
  are `#<n>`; a key of another repository (a sub-issue or a blocker may live
  elsewhere) is `owner/name#<n>`. How the interface's vocabulary maps onto
  GitHub:
  - closed states are the reason an issue was closed: completed is `done`,
    not planned is `canceled`, duplicate is `duplicate`; open states are a
    label per state (`issue_tracker.github.states_from: labels`, the
    default) or the option of a Projects board's single-select field
    (`project`); `todo` is the state with no label;
  - a project is a milestone; type can be kept in GitHub's issue types and
    any facet in an issue field of the repository's organization (priority
    in the Priority field, size in a field such as Effort), read in the same
    request as the rest of the issue and written in the request that files
    or changes it, every name resolved first, or each in labels (priority's
    `issue_tracker.github.priority_labels`). A facet the repository does not
    name gets GitHub's default before its first read or write: labels where
    its issues carry them, the organization's field where they carry its
    values or carry neither and the field qualifies, and a conflict that
    fails the facet's reads and writes where they carry both. The answer is
    cached on the machine for an hour; a read it could not make is an error
    naming the read and the credential, never labels;
  - parent and children are sub-issues, `blocks` is GitHub's issue
    dependency, `duplicate` closes the issue as a duplicate of the other and
    `related` is GitHub's own related link (`addRelatesTo`, read from
    `relatesTo`), so no relationship is kept as text. Earlier versions wrote
    a marked comment for `related`; the adapter still reads those, from
    comments by people who can write to the repository (the same rule makes a
    comment trusted), until `tracker.ts migrate-relations` has converted
    them;
  - the reports read the repository's issue list rather than GitHub's
    search, which returns at most 1,000 matches; text search for duplicates
    uses the search and refuses a result it cannot return in full. GitHub
    does not record when an issue started, so the stuck-epic census dates it
    no earlier than its real start (the time its state label was added, or
    its board item last changed);
  - GitHub Issues has no API to upload a file to an issue, and the adapter
    publishes nothing outside the issue, so an attachment is a comment that
    opens with a marker line naming the file
    ([`github/attachments.ts`](skills/do-item/scripts/lib/tracker/github/attachments.ts)):
    a text file whose comment fits GitHub's limit of 65,536 characters is
    carried in it, in a collapsed block a reader saves as the file
    (`form: comment`); given the address of a copy already hosted (`url`),
    the comment links it (`form: link`). A binary file, or a text file too
    long for one comment with no `url`, is refused, nothing written, so a
    decision sheet in the document layout, often longer, needs a hosted copy
    or stays a local file. Only a marked comment by someone who can write to
    the repository, or by the credential's own account, counts as an
    attachment, and one changed since it was written reads as changed, never
    as the file.

- **Linear** ([`linear.ts`](skills/do-item/scripts/lib/tracker/linear.ts)),
  the adapter `issue_tracker.adapter: linear` selects. It reads `LINEAR_API_KEY` or
  `LINEAR_API_TOKEN`, or uses a signed-in `linear` command-line client.
  Keys are `<TEAM>-<n>`, with the team from `issue_tracker.team`. Priority
  is Linear's priority field; type is labels; size is labels, or the
  issue's estimate where `issue_tracker.facets.size` names the native store,
  the sizes mapped onto the team's estimate scale
  ([`linear-facets.ts`](skills/do-item/scripts/lib/tracker/linear-facets.ts)),
  read once with the first read that needs it and refused where estimates
  are off or the scale has fewer points than the sizes. A file is uploaded
  to Linear's own file store (`fileUpload`, then the bytes, then
  `attachmentCreate` with its title and subtitle), its name and media type
  kept in the attachment's metadata; reading one back needs the API key,
  since Linear serves its uploads only to a signed-in request. Any other
  attachment (a pull request's, say) is a link
  ([`linear-attachments.ts`](skills/do-item/scripts/lib/tracker/linear-attachments.ts)).

- **Jira Cloud** ([`jira/`](skills/do-item/scripts/lib/tracker/jira/tracker.ts)),
  the adapter `issue_tracker.adapter: jira` selects: the issues of one
  project on one site (`issue_tracker.team` is the project key,
  `issue_tracker.jira.site` the site). It uses Jira's REST API version 3,
  at the site or through Atlassian's API gateway
  (`issue_tracker.jira.api_base`), signed with a Bearer token, an OAuth access token or an API token with
  scopes (`JIRA_BEARER_TOKEN`, or one `JIRA_TOKEN_COMMAND` prints), or with
  `JIRA_EMAIL` and `JIRA_API_TOKEN`, an Atlassian account's email address
  and an API token made for it
  ([`credential.ts`](skills/do-item/scripts/lib/tracker/jira/credential.ts)),
  and converts text between Markdown
  and ADF (Atlassian Document Format), the rich-text form Jira stores. Keys
  are `<PROJECT>-<n>`. How the interface's vocabulary maps onto Jira:
  - a state is the status whose name `issue_tracker.states` gives, matched
    ignoring case; a status no name matches is read by its status category
    (To Do: not started, In Progress: started, Done: completed). `done`,
    `canceled` and `duplicate` are told apart by their status, or, where
    they share one, by the resolution `issue_tracker.jira.resolutions` names
    (any of a state's listed resolutions), the first of which the adapter
    sets on the transition into it when the transition's
    screen has a resolution field. A move takes one transition, the one out
    of the current status into a status of the state's name, and is refused,
    naming the transitions there are, when none or several match. A
    workflow suits this with a status per state the repository uses,
    transitions into In Progress, In Review and Done that any status can
    take, and a resolution field on the Done transition's screen;
  - priority is a Jira priority (`issue_tracker.jira.priorities`, any of a
    priority's listed names read as it, the first written); a Jira
    issue always has one, so moving an issue to no priority is refused, and
    one with another priority reads as none;
  - type is labels, the issue type, or a custom field, and size labels or a
    custom field, as `issue_tracker.facets` names them
    ([`jira/facets.ts`](skills/do-item/scripts/lib/tracker/jira/facets.ts)):
    a custom field, named by its name or its id, is read in the request that
    reads the issue and written in the one that files or changes it, an
    option checked against the create or edit screen first; with the issue
    type as the store, a type with no standard issue type of its name, an
    issue under an Epic and a sub-task keep the type in its label, which
    wins over that fallback issue type when the issue is read;
  - the issue type is the tracker's own type, so an issue of type Bug or
    Task is typed without a label; a new issue gets
    `issue_tracker.jira.issue_type`, or under a standard issue the sub-task
    type (`issue_tracker.jira.subtask_type`), and an issue cannot be created
    under a sub-task;
  - a project is the issue's first fix version, and labels are Jira labels:
    they hold no whitespace, are shared by the whole site and are written as
    given; `file-issue` checks every proposed label against the site's labels
    before writing, so each taxonomy label and the debt ledger's label
    (`ledger.label` in the
    [fleet-health file](CONFIGURATION.md#the-fleet-health-file)) must
    already exist on the site;
  - parent and children are Jira's parent field, for sub-tasks and an
    Epic's issues alike, and relations are issue links of the types
    `issue_tracker.jira.link_types` names, several per relation where it
    lists them (each edge reported once, a new link written with the first,
    an `inverted` type read and written the other way round); links of other
    types are ignored;
  - every candidate pool and population is limited to the issue types
    `issue_tracker.jira.pool_issue_types` names, matched to the project's
    issue types when the site is first read; reads by key, an issue's
    children and reads a label defines are not;
  - a field a team relies on that Jig's interface has no place for (a size,
    a facet, an owning repository) reads as labels through
    `issue_tracker.jira.field_labels`: each value behind the field's
    prefix, selected in JQL by the field itself (a single-line text field
    only reads, since JQL matches it by words); an entry whose labels are a
    facet's values is that facet's field store, written as the facet, and
    the adapter writes no other entry's field;
  - a comment, or an assignment, is trusted when a person's Atlassian
    account made it, not a guest, that can be assigned issues in the
    project; an app's account, Jira Automation's own included, never is;
  - a file is uploaded to the issue as a Jira attachment
    ([`jira/attachments.ts`](skills/do-item/scripts/lib/tracker/jira/attachments.ts)).
    Jira keeps an attachment's file name and no title or subtitle, so the
    file name stands as its title, and a site with attachments turned off
    refuses the upload.

**To add one.** Implement the `Tracker` interface in a module beside
`linear.ts` (the facets an adapter keeps in the tracker's own fields are its
own to read and write; it passes its tracker through `withFacets` in
[`facets/tracker.ts`](skills/do-item/scripts/lib/tracker/facets/tracker.ts),
which keeps every other facet in labels, and adds the stores it can hold to
`ADAPTER_STORES` in
[`facets/config.ts`](skills/do-item/scripts/lib/tracker/facets/config.ts)),
register it in `ADAPTERS` in
[`index.ts`](skills/do-item/scripts/lib/tracker/index.ts), give its key
shape an entry in [`keys.ts`](skills/do-item/scripts/lib/tracker/keys.ts),
add its name to `issue_tracker.adapter`'s values in the audit's
[configuration schema](skills/audit/config-schema.yaml) and in
[CONFIGURATION.md](CONFIGURATION.md#issue_tracker), and test it as
`tracker.test.ts` and `tracker-github.test.ts` test the built adapters,
against a fake of the tracker's interface. Callers do not change. An
adapter maps its tracker onto the interface's vocabulary:

- an issue key has the shape the adapter's `keys.ts` entry defines; every
  caller that finds a key in text, reads one from a branch name or names a
  file after one goes through that entry;
- priority is a number from 0 (none) to 4 (low); a type is a type of the
  repository's label taxonomy and a size a label of its size group, each
  `null` for none, whatever the tracker shows;
- relations are directed and read from each issue's side: `relate A blocks
B` makes B wait for A, and B reads it as `blocked_by` A; `relate A
duplicate B` records A as the duplicate of B (the tracker may close A),
  and B reads it as `duplicated_by` A; `related` has no direction;
- a finished issue's workflow state belongs to one of the closed categories
  the metrics count (completed, canceled, duplicate); active states such as
  `in_progress` and `in_review` belong to none of them;
- a file is attached in the nearest form the tracker offers (its own file
  store, the file in a comment, or a link to a hosted copy), `form` saying
  which; one it can hold in no form is refused with `AttachmentRefused`
  before anything is written, never published elsewhere. Replacing older
  attachments is the interface's own (`attachReplacing` in
  [`attachment.ts`](skills/do-item/scripts/lib/tracker/attachment.ts)), on
  the file name or the title an adapter lists.

**What still assumes Linear.** These bypass the interface today, so a
second adapter does not yet reach them:

- **Deferring review findings.** `resolve-review-comments` files deferred
  findings through its own Linear client (`defer-batch.ts`), with fixed type
  and repository label groups; with GitHub Issues as the tracker, the
  default, deferred findings cannot be filed yet.
- **Native forms.** A skill run where the scripts cannot reach the tracker
  (no credential in that environment) may use a harness's own integration,
  and the skills give Linear's MCP tools as its example; every step they
  cover also has a script form, which works on every adapter.
- **Names.** The change-area catalog still accepts the older `linear:` block
  beside `tracker:`. The review-triage file's
  `severity_mapping.<severity>.priority` also accepts `linear_priority`, and
  `fractal-metrics.ts --skip-tracker` also accepts `--skip-linear`.

A repository gate (`scripts/check-tracker-boundary.ts` in Jig's own
repository) keeps the rest of the plugin's code, and the planning skills'
procedures, from reaching Linear except through the interface; the deferral
step is the one file it still allows.

Fixing it means moving the deferral step onto the interface. Roadmap item 10
holds the deferral step; item 12 holds the next adapter, a plan file kept in the
repository, behind open decisions: the plan file's format, and whether an
adapter may leave out the reporting operations.

## Reflection stores

Session reflection keeps its findings in a store that every repository on a
machine, or a whole team, writes to
([the store contract](skills/reflect/README.md#the-store-contract)). Unlike the tracker, a store is a command, not code inside Jig:

- **The contract.** The store command takes an operation (`check`,
  `append`, `list`, `diagnose`) as its first argument, reads JSON or
  [JSONL](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) on standard input, writes it on standard output,
  and exits 0 (done), 1 (failed), 2 (usage) or 3 (unavailable).
- **The stores.** `filesystem`, a folder of files and the default;
  `notion`, a Notion database people browse and filter; `github`, one issue
  per change in a GitHub repository the team chooses; and `command`, any
  command that keeps the contract. A Jira store is planned for later.
- **To add one.** Write a command in any language that keeps the contract,
  run the conformance suite (`store-contract.ts`) against it, and choose it
  with `reflection.store: command` and `reflection.command`
  ([fields](CONFIGURATION.md#reflection)). A store needs no change to Jig;
  one many teams want can still be contributed as a built-in.

## AI reviewers

Which reviewers the review loop works with is configuration: `review.bots`
lists the logins whose threads it resolves, and `review.reviewer_app`,
`review.reviewer_check_pattern`, `review.sticky_marker`,
`review.reviewed_sha_marker` and `review.skip_notice_marker` tell the drive
which check run and summary comment are the reviewer's evidence
([fields](CONFIGURATION.md#review)). A reviewer that submits pull-request
reviews instead of a summary comment is read through
`review.reviewer_evidence: review_object`; CodeRabbit is built in, so
`review.reviewer_app: coderabbitai` alone sets its check name and evidence.
The drive expects a reviewer only where `review.reviewer_app` or
`review.reviewer_check_pattern` is set; a repository with neither converges on
threads and CI alone.

Static-analysis tools that report to GitHub code scanning (CodeQL,
SonarQube Cloud, Semgrep, any tool that uploads results) need no
configuration: the review loop recognises a thread GitHub opened for a
code scanning alert, reads the finding's severity from the alert, and
dismisses the alert when it declines the finding
([code scanning alerts](skills/resolve-review-comments/README.md#code-scanning-alerts)).
A tool that reports only through a check's annotations, or only in a summary
comment, raises no thread, so the loop does not see its findings.

### Severity formats

In late rounds the review loop can decline a finding it would otherwise fix
([the decline ladder](skills/resolve-review-comments/references/triage-rubric.md#the-decline-ladder)),
and how far it may go depends on the finding's severity. Each reviewer writes
severity its own way, so Jig reads it through a **severity format**: the
reviewer's login, the shape of the field, and how the reviewer's words map
onto Jig's `blocker`, `high`, `medium` and `low`. A format is read only from
comments its own login posted, so prose that happens to look like a severity
field, from anyone else, is never read as one. A finding no format reads has
an unknown severity. Where the repository's
[review-triage file](CONFIGURATION.md#the-review-triage-file) lists
`severity` under `fail_open.inert_when_unknown`, the ladder then stays inert
for that finding; where it does not, the severity clause abstains and the
ladder's other clauses decide.

Built in, each checked against the reviewer's real comments:

| Reviewer                                                                         | Login                     | Shape                                                                                | Words                                                       |
| -------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| CodeRabbit                                                                       | `coderabbitai`            | `pipe-fields`: `**🔒 Security** \| **🟠 Major** \| **⚡ Quick win**`                 | `Critical` blocker, `Major` high, `Minor` and `Trivial` low |
| CodeRabbit                                                                       | `coderabbitai`            | `icon-fields`: `**<picture><img …></picture> Major** · **Security** · **Quick win**` | the same words                                              |
| Greptile                                                                         | `greptile-apps`           | `html-badge`: an `<img alt="P1">` badge at the head of the finding                   | `P0` blocker, `P1` high, `P2` medium                        |
| Codex connector                                                                  | `chatgpt-codex-connector` | `badge`: a `![P1 Badge]` image at the head of the finding                            | `P0` to `P3`: blocker to low                                |
| The repository's configured reviewer (`review.reviewer_app`, else `review.bots`) | its own                   | `bold-token`: `🟡 **medium** · 🏷️ category: correctness`                             | Jig's own words                                             |

The `bold-token` row is **Jig's own finding format**. A reviewer a team builds
itself, an agent running in CI for example, gets severity and category
triage by opening each finding with it, once its login is the configured
reviewer or has an entry of its own below. The bullets of the reviewer's
summary comment are read in this format, after the formats of the login
that posted it.

GitHub code-scanning threads carry no severity token in their comment. Their
same-repository details link identifies an alert: its `rule.security_severity_level`
(`critical`, `high`, `medium`, `low`) takes precedence over `rule.severity`
(`error`, `warning`, `note`). The defaults map those to blocker, high, medium,
low, high, medium and low respectively. A repository can override individual
levels in `review.code_scanning_severities` ([fields](CONFIGURATION.md#review)).
Thread triage and loop metrics use the same alert mapping; an alert the token
cannot read remains `unknown` and keeps the ladder inert where configured.

Any other reviewer is added in `review.severity_formats`
([fields](CONFIGURATION.md#review)), one entry per login, without a change to
Jig:

```yaml
review:
  severity_formats:
    - login: example-reviewer[bot]
      shape: bold-token # 🔴 **Critical** · …
      severities: { Critical: blocker, Major: high, Minor: medium, Nit: low }
```

A repository's entries are tried before the built-in ones, and add to them
rather than replace them: a comment an entry does not read is still tried
against the built-in formats for the same login. An entry picks
one of the supported shapes and supplies the reviewer's words; it cannot
describe a field built another way (a different decoration before the word,
a different layout). That is a new shape, a change to Jig with fixtures from
the reviewer's real comments, as is a reviewer many teams use contributed as
a built-in.

## Forge: GitHub

The skills that work on pull requests (`drive-pr`, `resolve-review-comments`,
`do-item` opening a pull request, `fix-ci`, the audit's configuration check,
`descar`'s open-pull-request check) call the GitHub command line (`gh`)
directly. There is no forge interface: GitHub is the one platform Jig
supports. What they rely on:

- pull requests (state, base, draft and Ready) and their labels and comments;
- review threads, read, replied to and resolved through GitHub's GraphQL
  interface;
- check runs and commit statuses on a commit, and the required checks of
  branch protection and rulesets;
- GitHub Apps and `<app>[bot]` logins to recognise a reviewer;
- GitHub's stacks and the `gh-stack` extension, for
  `pull_requests.stacking: native`;
- `CODEOWNERS` and the "delete head branches on merge" setting, read and
  reported.

**Works without GitHub:** `adr`, `change-areas`, `code-stats`, `decide`, `explain`, `design-brief-builder`,
`programmatic-execution`, `promote-memory`, `resolve-conflicts`, `review` on a
local diff, `fix-ci` on a saved log (`--log <file>`), and the audit with
`--offline`. The modules' reference gates take their input as files or
arguments, and [M7's mappings](https://github.com/jig-harness/jig/blob/main/modules/M7-pr-lifecycle-review/mappings.md)
state the review practice for GitLab and Gitea as well.

**The git remote** is the one `repository.remote` names, `origin` by
default ([CONFIGURATION.md](CONFIGURATION.md#repository)): the drive pushes to
it, fetches the base from it and derives the integration branch from its
`HEAD`, and `do-item`, `fix-ci`, `resolve-conflicts` and `work-batch` fetch
and push through it. The drive refuses rather than pushes when that remote
is not the pull request's repository. `review`, `review-reflections`,
`reflect`, `code-stats`, `changelog` and the audit still read `origin`.

**What a second forge needs.** A forge interface on the model of the tracker
interface: the operations above, a GitHub implementation that the skills'
direct `gh` calls move into, then a second implementation (GitLab, through
its `glab` command, is the nearest). In `drive-pr`,
`resolve-review-comments` and `do-item` the `gh` calls already pass through
two helpers that add timeouts and caching, which is where the interface
starts; `fix-ci`, the audit and `descar` start `gh` through runners of their
own, and some skills tell the agent to run `gh` itself. The shared runtime
kernel gathers common timeout and cancellation behavior in `shared/`. A forge
interface is listed under the roadmap's later work, to be built when a team
on another forge needs it.

## CI system

Jig reads CI results from the forge, not from the CI system: the drive waits
for the check runs and commit statuses GitHub shows on a commit. Any CI that
reports to GitHub works (GitHub Actions, and GitLab CI, CircleCI, Buildkite
or Jenkins through their GitHub integrations). Where the required checks
cannot be read from branch protection, `ci.required_checks` names them.
`ci.hold_label` is a GitHub label the repository's own workflows must honour;
any CI that can read a pull request's labels can.

Bound to GitHub Actions today:

- **`fix-ci` downloading a failed run's log** (`gh run view --log-failed`).
  A CI that reports as commit statuses (Jenkins through its GitHub Branch
  Source plugin, for one) has its logs read through the repository's
  `ci.log_command`, and its repair skill named in `ci.repair_skill`. With
  any other CI, save the log and run `parse-ci-log.ts --log <file>`; the
  sorting, fixing and local verification are the same.
- **The `github-actions` skill**, which reviews `.github/workflows` by
  definition. A review skill for another CI's files would be a sibling, not
  an option of this one.

The practice modules are written for any CI: their `mappings.md` give GitHub
Actions and GitLab CI side by side, and several name others. The audit
recognises the configuration files of GitHub Actions, GitLab CI, CircleCI,
Bitbucket Pipelines, Jenkins, Buildkite and others, and reads the jobs of the
first two. A CI provider interface for `fix-ci` (finding the failed run and
downloading its log) is listed under the roadmap's later work.

## Agent tools

The plugin installs into **Claude Code** and **Codex** from the same
`plugin/` directory, and every skill runs in both. The differences are in
the [Codex notes](README.md#codex-notes): Codex does not fill in the skill's
folder path, loads plugin agents only from its own folders, and the drive's
default pass starts Claude Code. Any other agent tool can use the skills by
copying or linking the whole `plugin/skills/` directory into its skill
folder, keeping every skill beside the others, and `plugin/shared/` into a
`shared/` folder beside that skill folder
([where it works](README.md#where-it-works)): skills' scripts import code
from `shared/` and from sibling skills (`fix-ci` from
`resolve-review-comments`, for one), so a single skill copied alone does not
run. The scripts need Bun, git
and the GitHub command line ([requirements](README.md#requirements)), and no
packages.
Supporting a third tool as a plugin means a manifest for it beside the existing ones in
`plugin/`, and a test in `tools/plugin/plugin.test.ts`.

## Workspace launcher

The [launcher](https://github.com/jig-harness/jig/blob/main/tools/launcher/README.md) connects an issue tracker's
"open in coding agent" button to a workspace on the machine. It has
interfaces of its own, with implementations chosen in
`~/.linear/launcher.yaml`:

- a **tracker** ([`tracker.ts`](https://github.com/jig-harness/jig/blob/main/tools/launcher/tracker.ts)): Linear and GitHub Issues;
- a **workspace provider** ([`provider.ts`](https://github.com/jig-harness/jig/blob/main/tools/launcher/provider.ts)):
  Herdr, the workspace runtime Jig's tooling targets first
  ([ADR-0005](https://github.com/jig-harness/jig/blob/main/docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)),
  on macOS and Linux and on a remote host; Orca, on macOS and Linux and on
  a paired Orca server; and Conductor, which runs on macOS only.

A new provider is a module in `tools/launcher/providers/` that validates its
per-repository settings and opens the workspace, registered in `index.ts`
there; a tracker is added the same way under `trackers/`.

## Operating systems

The skills are TypeScript run by Bun, which runs natively on macOS, Linux
and Windows ([ADR-0001](https://github.com/jig-harness/jig/blob/main/docs/adr/ADR-0001-bun-typescript-toolchain.md)).
Every pull request to Jig is tested on Linux, and `main` on macOS and Windows
every night, where Windows leaves out only the suites listed in
`POSIX_ONLY_SUITES` in [scripts/gates.ts](https://github.com/jig-harness/jig/blob/main/scripts/gates.ts).

| Part                             | macOS | Linux                                | Windows                                                                  | Why                                                                                                 |
| -------------------------------- | ----- | ------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `drive-pr`                       | yes   | yes                                  | PowerShell or Git Bash; authenticated smoke pending                      | Bun commands use plain arguments                                                                    |
| `do-item`                        | yes   | yes                                  | PowerShell or Git Bash; authenticated smoke pending                      | Bun commands use plain arguments                                                                    |
| The launcher                     | yes   | yes, with the Herdr or Orca provider | no                                                                       | Conductor is a macOS app; Herdr runs on macOS and Linux; the Orca provider is not tested on Windows |
| The Herdr workspace tool         | yes   | yes                                  | no                                                                       | Herdr's Windows support is in beta and not yet a target                                             |
| The Orca workspace tool          | yes   | yes                                  | not tested                                                               | Orca runs on Windows, but the tool's hook and SSH steps are POSIX shell                             |
| Every other skill                | yes   | yes                                  | yes                                                                      | —                                                                                                   |
| Developing Jig (`bun run gates`) | yes   | yes                                  | yes, without the launcher's, the Herdr tool's and the Orca tool's suites | —                                                                                                   |

The supervision code finds and stops Windows processes from native snapshots
and a stop the driver polls its mailbox for. Batch command shims run through `cmd.exe`; skill
instructions use Bun commands with plain arguments. The `fix-ci` setup command
runs through Bun's native shell; its external tools belong to the consumer.
The complete authenticated pickup, draft pull request, drive round and stop
smoke test on Windows, under Claude Code and under Codex with PowerShell,
remains pending. See the [requirements](README.md#requirements) for
the current platform boundary. On every system, Jig keeps its
state under `~/.local/state/jig` and `~/.cache/jig` in the home folder,
rather than in each system's own application-data folder.

## Practice mappings

The modules state each practice as an invariant that holds whatever the
tools, and each module's `mappings.md` names the tools that implement it in
each ecosystem: CI providers, hook managers, forges, trackers, agent tools,
package managers, telemetry backends. A team on a tool not listed there
adds a row or a section, with the tool's real configuration, in a pull
request to Jig ([modules/AGENTS.md](https://github.com/jig-harness/jig/blob/main/modules/AGENTS.md)). Each row is a
fact a reader can check, so it names what exists, not what is planned.

## Contributing an extension

An adapter, provider, command hook or new field arrives in Jig by pull
request, under [CONTRIBUTING.md](https://github.com/jig-harness/jig/blob/main/CONTRIBUTING.md) and
[plugin/AGENTS.md](https://github.com/jig-harness/jig/blob/main/plugin/AGENTS.md):

- **Values stay with the team.** The implementation holds the mechanism; a
  team's names, labels, hosts and credentials reach it through
  configuration or the environment, never as constants in the code.
- **Behind the interface, chosen by a field.** Callers use the interface,
  never the implementation; the field that chooses it goes into
  [CONFIGURATION.md](CONFIGURATION.md) and the audit's schema in the same
  pull request.
- **Tested without the service.** Tests run against a local fake of the
  service, so they run in CI without credentials.
- **Runs from the plugin cache.** No package dependencies at run time: Bun's
  built-ins, or a vendored single-file build with its licence
  ([adding a plugin skill](https://github.com/jig-harness/jig/blob/main/CONTRIBUTING.md#adding-or-changing-a-plugin-skill)).
- **Move, never copy.** An adapter a team already runs moves here with its
  tests, and the team deletes its own copy.


Facet migrations read `PoolIssue.hiddenLabels` alongside its visible labels,
and refuse `unmappedFacets` before overwriting a nonempty store whose value
has no canonical mapping. An adapter must preserve that evidence when it
normalizes a native value. `IssuePatch.facetLabels` restores the exact label
representation of a facet from a move record; each label must belong to the
facet's configured label codec. It cannot set workflow or arbitrary labels.
Sweep pages pass one `FacetReadOptions.census` object to share a census;
new objects start fresh reads and the caller supplies the shared deadline.
