# Workspace launcher

Issue trackers can offer an "open in coding agent" button, but the button only
runs a program on your machine. Without a launcher, that program either opens
a workspace for the wrong repository (when several are registered), starts the
agent with a prompt too short to carry the issue, or does nothing about who is
working on it. The launcher is that program: it assigns the issue to whoever
opened it, writes the whole issue (description, comments, sub-issues, links) to
a file the agent reads, picks the repository from the issue's label, and opens
a workspace for the agent. With the Herdr provider a routed issue opens as a
Herdr worktree workspace, on this machine or on a remote host, with the
agent started and given the prompt. With the Conductor provider a routed
issue opens Conductor's new-workspace composer with the prompt filled in,
and the agent starts when you click **Create**; an unrouted issue creates
(or reopens) its workspace directly.

It is machine tooling, not an agent skill. The tracker runs it, not a session,
so it lives here and runs from a checkout of this repository rather than from
the plugin's copy.

## Install

```sh
bun install --frozen-lockfile        # once, in this checkout
bun tools/launcher/install.ts        # wire it; safe to repeat
bun tools/launcher/install.ts --check
```

The installer merges one entry into `~/.linear/coding-tools.json` (other keys
survive; a changed file is first copied to `coding-tools.json.bak-<time>`) and
writes a starter `~/.linear/launcher.yaml` only when none exists. It checks
everything before writing anything, and undoes its earlier writes when a later
one fails, so a failed install leaves a working setup as it was. Run one
install at a time: two concurrent runs are not serialized, and one undoing its
writes can undo the other's. It never writes your API key. Create that
yourself, once, private before the key lands in it (this also covers an
existing file others can read):

```sh
(umask 077 && mkdir -p ~/.linear && touch ~/.linear/api-key \
  && chmod 600 ~/.linear/api-key && printf '%s' "lin_api_…" > ~/.linear/api-key)
```

With the default configuration no issue is routed, and the Conductor provider
opens an unrouted issue by its Linear key, which Conductor can only resolve
when your Linear account is connected inside Conductor. Connect it there, or
route your repositories (see Configuration).

The installer works around these traps:

- The tracker's desktop app is a graphical program started without your shell profile, so neither
  an exported `LINEAR_API_KEY` nor `bun` on `PATH` reaches the launcher. The key
  comes from the key file, and the entry names the absolute path of the `bun`
  that ran the installer. Run the installer again after changing the Bun
  version; `--check` reports a path that no longer exists.
- The tracker accepts only its own variables in the entry's `env`
  (`LINEAR_PROMPT`, `LINEAR_ISSUE_BRANCH_NAME`) and rejects the whole file
  with "Unsupported env var" if `LINEAR_API_KEY` is listed.

Without a key the launcher still opens a workspace, but it cannot assign the
issue, route it to a repository or cache the comments.

## Configuration

`~/.linear/launcher.yaml` (override the path with
`JIG_LAUNCHER_CONFIG`; the tracker starts the launcher without that variable,
so the override reaches only a launcher run by hand). It belongs to the machine, not to a repository,
because the tracker starts the launcher before any repository is known.

| Key | Default | Meaning |
|-----|---------|---------|
| `tracker` | `linear` | Which issue tracker the issue is read from. |
| `provider` | `conductor` | Which workspace provider opens the issue. |
| `skill` | `/jig:do-item` | The slash command the first prompt starts with; the issue key follows it. |
| `repo_label_group` | `Repo` | The tracker label group whose value names the repository. |
| `repos` | none | Repository label → that repository's settings, one entry per provider. |

```yaml
provider: conductor
repos:
  my-service:
    conductor: my-service      # the repository's name in Conductor
  my-website:
    conductor: Website
```

An issue whose label has no entry, that carries no label in the group, or whose
labels could not be read in full, is not routed; the provider then detects the
repository itself.

## What happens on launch

1. Read the issue from the tracker. Linear's reader follows every connection's
   cursor, so an issue with more than 250 comments or labels loses none, and the
   whole read has a 30 second budget.
2. Assign the issue to the API key's owner unless it is already theirs. This
   runs after the reads with its own 10 second budget, and a failure only warns.
3. Write `~/.cache/conductor-linear/<KEY>.json` (mode 600, replaced whole so no
   reader sees a partial file). The directory name is historical: it predates a
   second launcher and every launcher shares it so the issue-pickup skill needs
   no per-launcher branch.
4. Choose the repository from the label, and hand the prompt to the provider,
   which has 30 seconds to open the workspace unless it sets its own budget
   (Herdr's is derived from its tool's own limits).

The prompt is short on purpose (deep links cap its length). Its first line is
the skill and the key; it also names the cache file, because the skill reads
launcher context from a file its instructions name.

### The cache file

| Field | Meaning |
|-------|---------|
| `identifier`, `title`, `description`, `branch_name` | The issue's own fields. |
| `cached_at` | Seconds since the epoch. The skill trusts the file for 30 minutes, which must outlast workspace setup. |
| `comments` | `{ body, author_id, created_at? }`, oldest first. |
| `comments_cached` | `true` whenever `comments` is written: the skill counts the comments as read only then. |
| `sub_issue_ids` | Keys of the issue's children. |
| `linked_issue_ids` | Keys of related issues, in either direction (an issue that blocks this one included); background only. |

A field is **left out** rather than written truncated when its connection could
not be read in full (a page failed, the deadline passed, a cursor looped, a node
had the wrong shape, Linear reported an error for it). An issue with no
description (Linear returns `null`) is cached with an empty one. A description
Linear reports an error for, or returns missing or as anything other than text
or `null`, is never written as an empty one: with no description from the
tracker's own environment, the cache is not refreshed at all. The skill treats a missing `comments` array as "not
cached" and fetches it, whereas a truncated array would look complete and hide
the newest comment. `linked_issue_ids` is the exception: the skill has no
refetch path for it, so the valid entries are kept.

## Trackers

A tracker reads and assigns the issue; see [tracker.ts](tracker.ts). Linear
([trackers/linear.ts](trackers/linear.ts)) is the only one, and the installer
wires Linear's desktop app. To add one, add `trackers/<name>.ts` exporting a
`Tracker` and register it in `trackers/index.ts`; the launch code does not
change.

## Providers

A provider performs the last step and nothing else; see
[provider.ts](provider.ts).

| Provider | How it opens the issue | Status |
|----------|------------------------|--------|
| `conductor` | A `conductor://` deep link. A routed issue uses `prompt=…&path=<repository root>`; an unrouted one uses `linear_id=<key>`, which makes Conductor guess the repository. The root comes from Conductor's own database, read-only. | shipped |
| `herdr` | The [Herdr workspace tool](../herdr/README.md)'s `open`, on this machine or on the host the repository's settings name: the issue's branch as a worktree workspace (reattached when it exists), the agent started and the prompt sent once per issue. A routed issue only. | shipped |

Conductor reads `repos.<label>.conductor` as a repository name. Its database is
Conductor's private storage, not a documented interface; when it cannot be read
the provider falls back to detection instead of failing the launch.

Herdr reads `repos.<label>.herdr` as the clone's path on the machine Herdr
runs on, or as a mapping:

```yaml
provider: herdr
repos:
  my-service:
    herdr:
      path: ~/dev/my-service   # the clone, on the host
      host: build-box          # SSH destination; this machine when absent
      agent: codex             # Herdr agent kind; claude when absent
      base: origin/main        # base of a new branch; the clone's origin/HEAD when absent
      branch: feature/{key}-{slug}   # how the repository names an issue's branch
```

The branch is the one the launch names, else the one the tracker suggests
(read with the issue), else the issue key in lower case, unless the
repository names its branches with `branch`. There, `{key}` is the issue key
as the tracker writes it and `{slug}` the title's
[slug](../../GLOSSARY.md): its first four words in lower case, joined by
hyphens: `feature/{key}-{slug}` opens `ENG-12` as
`feature/ENG-12-fix-the-login-page`. A branch already started for the issue
is kept even after its title changed: the tool opens the one existing branch,
local or on origin, that starts with the name's part before `{slug}`
(`feature/ENG-12-`). When there are several, it opens the one the launch
would name if that is among them, and otherwise refuses, naming them. So the
name must hold `{key}` once, and `{slug}` at most once after it, with text
between that does not open with a letter or digit, or that part would also
start another issue's branch (`ENG-1`'s would start `ENG-12`'s). On a host, the
issue's cache file is copied first to the same path under the host user's
home, and the prompt names that copy; when this launch could not write the
cache file, the launch is refused rather than copying a missing file or an
earlier launch's. On this
machine, the tool runs with the login shell's `PATH`, so a `git` or `herdr`
installed where only the shell profile adds it is found. Herdr has no
repository list to detect one from, so an issue that is not routed is
refused with what to add. The provider's budget is not 30 seconds but the
Herdr tool's own limit for `open`, which the tool holds itself to (sized
from the create hook, the agent's start and the kickoff), plus the cache
copy and the SSH connection, so the launcher never ends a run the tool
allows. A setup
that outlasts the cache file's 30 minutes still starts the work: the skill
then reads the issue from the tracker instead.
The host's requirements and what the tool keeps are in its
[README](../herdr/README.md).

To add a provider, add `providers/<name>.ts` exporting a `Provider`, register it
in `providers/index.ts`, and document its `repos.<label>.<name>` settings here.
Neither the launch code nor the cache changes.
