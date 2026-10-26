# Orca workspace tool

Starting an agent on a piece of work in [Orca](https://www.onorca.dev), the
desktop and remote agent environment, takes the same steps as anywhere else,
and the same ones go subtly wrong when done by hand: pick or create the
branch without forking one that already exists on the remote, give it the
name the repository expects, set the worktree up, start the agent and hand it
its first prompt. Orca's own worktree creation names a new branch after the
worktree, under a prefix of its own, and its command line has no way to name
the branch; opening the same work twice from a tracker's button makes a
second worktree beside the first, or prompts an agent already halfway
through. This tool does those steps through Orca's command-line tool, in
Orca on this machine or on a paired Orca server, and opening the same work
twice ends in the same place as opening it once.

It is machine tooling, like the [launcher](../launcher/README.md), which uses
it as its `orca` provider: it runs from a checkout of this repository, not
from the plugin. Herdr remains the [workspace runtime](../../GLOSSARY.md)
Jig's tooling targets first
([ADR-0005](../../docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md));
Orca is supported through the same interfaces, as Conductor is.

## What it does

```sh
bun tools/orca/workspace.ts open --repo <name> --branch <name> [--environment <name> --ssh <host>] \
    [--reuse-prefix <text>] [--base <ref>] [--agent <id>] [--no-agent] [--prompt <text>] [--key <key>] \
    [--comment <text>] [--linear-issue <key>] [--activate] [--clone-url <url> --clone-root <dir>] [--json]
bun tools/orca/workspace.ts remove --repo <name> --branch <name> [--environment <name> --ssh <host>] [--force]
```

`--repo` is the repository's name in Orca (`orca repo list`), on the machine
Orca runs on. **`open`** creates the branch's worktree through Orca, or
reattaches to the checkout that already has the branch. With
`--reuse-prefix`, which `--branch` must start with, it first chooses the
branch: the one existing branch, local or on origin, whose name starts with
it is opened instead of `--branch`, so work started under an earlier name
keeps its branch; several stop the run unless `--branch` is one of them.
When Orca has no repository by that name and `--clone-url` and
`--clone-root` are given, it is cloned and added to Orca first
([below](#a-repository-orca-does-not-have)). Then:

1. It looks for a checkout of the branch in the clone's own `git worktree
   list`. One that Orca lists is reattached. One Orca does not list (a
   worktree made with plain git, which Orca hides until asked to show
   non-Orca worktrees) is refused rather than duplicated; the message says
   how to show it.
2. With none, it decides where the branch comes from, as the
   [Herdr workspace tool](../herdr/README.md) does: origin's copy, a local
   branch origin does not have, or a new branch cut from `--base` (the
   clone's `origin/HEAD` by default) after fetching it. A local branch with
   commits origin lacks stops the run: a person decides which side wins.
   Every git check that cannot answer is an error, never read as "absent".
3. It creates the worktree with `orca worktree create`, from that starting
   point, with Orca's own setup hook skipped, checks that the worktree Orca
   reports is a linked worktree of the repository's own clone (a stale or
   wrong answer must not have branches renamed elsewhere), and then **names
   the branch**: Orca names a new branch after the worktree under its own
   prefix (`<git user>/feature-eng-12-fix-the-login` for a worktree named
   `feature/ENG-12-fix-the-login`), so the tool renames a fresh branch, or
   checks out the existing one and deletes Orca's. Orca reads the branch
   from git, so it follows, and `--worktree branch:<name>` selects the
   worktree from then on.
4. On every open, reattaching included, it sets the branch to track its
   origin copy when origin has one (a repair an earlier open could not
   finish is made now), and `--linear-issue` links the issue to the worktree
   in Orca's Linear integration; when that integration is not connected the
   link only warns, and the next open tries again.
5. It runs the repository's create hook (`.config/worktree-hooks/create`,
   [M12](../../modules/M12-parallel-agent-ergonomics/README.md)) inside the
   worktree, once, however many opens reach it at the same time: the open
   that creates the claim directory in the worktree's git directory
   (`jig-orca-create-hook.claim`) and finds no mark (`jig-orca-create-hook`)
   under it runs the hook, and the others wait for the mark, up to the
   hook's limit. The mark is read again under the claim, since the holder
   writes it before giving the claim back: an open that takes the claim as
   another finishes neither runs the hook again nor, having waited, reports
   a failure. A run that succeeded leaves the mark and gives the claim back;
   one that failed gives the claim back and leaves no mark, so the next open
   runs the hook again, and an open that waited for it stops. A claim left
   by a run that was killed is named in the message, for a person to
   remove. The hook runs
   after the branch has its name, since a hook may read it. On this machine
   it runs under the [Herdr workspace tool](../herdr/README.md)'s
   supervisor, which ends the hook and every process it started when it
   fails, outlives its limit, or the tool has gone; on a server's host it
   runs as one SSH command under the call's deadline, and a hook that
   outlives it, or a child it leaves behind, is left to the host
   ([what is left](../../ROADMAP.md)).
6. It starts the agent (`claude` unless `--agent` names another Orca agent
   id) in the worktree with `--prompt` as its first prompt, once per
   `--key` and agent, as below. `--comment` is kept in Orca's metadata, and
   `--activate` reveals the new worktree in the app.

**`remove`** runs the repository's remove hook inside the worktree, parks the
worktree's unsent [reflection](../../plugin/skills/reflect/README.md)
findings, and only then removes the worktree through `orca worktree rm`.
When either step fails the worktree stays. `--force` removes a worktree with
uncommitted changes, which Orca refuses otherwise. Orca also deletes the
worktree's local branch when it can tell the branch is merged, and keeps it
otherwise. Parking runs the reflection journal in this process, so it
happens only when the clone is on this machine. On a server's host the tool
reads the worktree's journal over SSH, where the configuration on the host
puts it, choosing the configuration files as the reflect skill chooses them
there from the host's environment (what its non-interactive shell exports):
`reflection.journal` in the worktree's `.config/jig.yaml`, or in the file
`JIG_OVERLAY` names instead, else in the host user's `~/.jig/jig.yaml`
(`JIG_HOME` moves it; `JIG_USER_LAYER=off` leaves it out), else the
journal's default place in the worktree's git directory. A path setting is
expanded as the skill expands it: `~` is the host's home directory, a
relative path the worktree's. A `JIG__…` variable of a session on the host
is not seen. It refuses the removal while unsent findings are in the
journal, since removing the worktree would delete them: run `/jig:reflect`
in the worktree there, or park them there with the reflect skill's
`journal.ts park`, and remove it again. It refuses as well while it cannot
tell where the journal is, or whether it is there: a configuration file on
the host it cannot read or parse, a `reflection.journal` that is not a path,
a relative `JIG_HOME` or `JIG_OVERLAY` (a session there resolves one against
its own directory), a path it cannot inspect (a parent it may not search, a
filesystem error), or a directory or special file where a configuration file
or the journal should be. Only a path the host reports nothing at counts as
absent. The receipts of the agents started in the worktree stay (below):
the next open of their keys tells them from the worktree standing at the
path then, by its token, and starts an agent again.

**`--environment`** names a paired Orca server (`orca environment list`), so
Orca's tool runs here and reaches the server, and the worktree is created on
the server's machine. Git and the hooks must run where the clone is, so
`--ssh` names that machine's SSH destination, which needs `git` and a POSIX
shell (`sh`, `test`, `mkdir`, `rm`, `cat`, `ls`, `ln`, `od`, `tr`, `env`,
and `/dev/urandom`) on the `PATH` of a non-interactive SSH session and an
SSH key the caller can use without a prompt, and nothing from Jig. A path Orca reports is a path on the server.

Each command holds itself to a time limit: every git and Orca call and hook
run is cut to the time left, so a run ends at its limit, saying so, however
many steps it took. `open` allows for the create hook (15 minutes, since a
dependency install is slow), a wait on another open's start of the agent,
and the calls around them; the launcher's budget is that limit plus the
connection around it.

Exit codes: 0 done; 1 a step failed, and the message says what to do; 2
usage.

## A repository Orca does not have

A machine meant to hold every repository of an organization, such as an
always-on Orca server, is rarely kept complete by hand. With `--clone-url`
and `--clone-root`, an `open` of a repository Orca does not have makes it
available first, on the machine the clone goes on (this one, or `--ssh`'s):

1. It reads the root, absolute or under `~/` (the home directory that
   machine's shell reports), creates it if needed, and takes a claim beside
   the clone's path (`<root>/.<repo>.jig-orca-clone`, which `mkdir` creates
   for exactly one open). An open that finds the claim held waits, up to the
   clone's limit (10 minutes), until Orca has the repository, and stops when
   the claim is given back without it.
2. Under the claim it asks Orca again, since an open that held the claim
   before may have added it. Otherwise it clones the URL into
   `<root>/<repo>`; a directory already there is used only when it is the
   top of a clone whose `origin` is that URL, and anything else there stops
   the run for a person to look at. The URL must be `https://`, `ssh://` or
   `git://` with a host and a path, an SSH `user@host:path`, or an absolute
   path; messages show it with any `user:secret@` hidden. The clone runs
   without a terminal, so the machine needs credentials for the URL that ask
   nothing (an SSH key, a credential helper). A clone that does not end on
   its own (its limit, a lost SSH session) keeps the claim, since git may
   still be writing there; the message names what to remove once it is not.
3. It adds the clone to Orca (`orca repo add --path`), which names the
   repository after its directory, gives the claim back, and goes on with
   the open. A new branch is cut from the clone's `origin/HEAD` unless
   `--base` says otherwise.

Orca's own `orca project setup-clone` clones onto a host too; the tool uses
plain `git clone` and `repo add` so the clone has the same name, path and
credentials on a machine as over SSH, and so a clone of the same URL that
is already there is reused.

## Starting the agent once

Orca does not say whether an agent in a worktree already received a prompt,
so the tool keeps its own record, a **receipt** per key and agent, in
`~/.jig/orca/kickoff/local/<repository id>/<key>.<agent>.json` for Orca on
this machine and `~/.jig/orca/kickoff/server/<name>/<repository id>/…` for
a paired server (`JIG_HOME` moves `~/.jig`; a name is percent-encoded where
it holds anything but letters, digits, `_` and `-`, so the `.` between the
key, the agent and `json` is the only one in the file name, and `ENG-1.a`
with agent `b` is not `ENG-1` with agent `a.b`), written on the machine the
tool runs on. The repository id is Orca's, so the same key in two
repositories is two starts, and so are two agents on one key.

- An open with a `--key` and no receipt creates one as pending, which
  succeeds for exactly one open at a time, starts the agent, and completes
  the receipt with Orca's answer. The next open of the same key finds it and
  starts nothing, whether it reattached or not, and says where the agent
  was started. A second open at the same moment finds the pending receipt
  of an open still running on this machine, waits for it (2 minutes at
  most), and then reports the start as already made.
- A pending receipt whose open has ended, or that another machine's open
  wrote, records a start whose outcome was never learned (the launch was
  cut short). When it carries this worktree's token (below), or another
  machine's open wrote it, the tool stops and says to look at the worktree
  in Orca and delete the file if the agent never started, rather than start
  a second one. When its open ended on this machine and it carries another
  token, the worktree the agent was being started in is gone or no longer
  holds the branch, so the receipt is set aside like a completed one of
  such a worktree, and the agent is started here. An answer from Orca that
  nothing started (an agent it does not have, say) clears the receipt, so
  the next open starts the agent once that is fixed.
- A receipt stands for the worktree its agent was started in and no other.
  The first open that starts an agent in a worktree writes a token into the
  worktree's git directory (`jig-orca-worktree`, for exactly one open: a
  second open that finds none reads the first's), and the receipt carries
  it. A worktree created later at the same path, which Orca gives the same
  id, has a git directory of its own with no token or another, so no receipt
  of the earlier one reads as its own, for any key or agent, and nothing has
  to be set aside before a worktree is created, or after a creation that
  fails. An open whose receipt carries another token sets it aside and
  records the start anew, whether it reattached or created the worktree:
  the stale receipt is linked under a name carrying the start it records,
  which only the first open to try can do, and is read again under that
  name, since what the open read before is a hint: when the file holds
  another receipt by then (the one read was cleared by its open and one
  created anew), the link is removed and the file is read again; otherwise
  the pending receipt takes its place without the file being absent in
  between. A second open that read
  the same stale receipt waits for the replacement (2 minutes at most), then
  finds the start made; the message past that names the copy to remove when
  the open that made it never finished. `remove` leaves the receipts of the
  worktree it removed in place: a worktree created at its path afterwards,
  which Orca gives the same id, is told from it by its token, and an open
  may have created one, and started an agent in it, before `remove` could
  look, so `remove` decides nothing by the id.
- A receipt that is not whole, or names another launch, is refused rather
  than read as any outcome; the message says to move it away.
- An open without `--key` starts the agent every time; `--no-agent` starts
  none.

The record is per machine: two machines opening the same key on one server
each start an agent. One launcher machine per server keeps it to one.

## Orca on a host

A machine that is always on can run Orca's server without a desktop, so
agents keep working when a laptop closes, and the Orca app and Orca Mobile
show its worktrees from anywhere on the same private network (a tailnet, a
local network, an SSH tunnel). Orca's own pages are the reference:
[Remote Orca Servers](https://www.onorca.dev/docs/remote-servers) and
[Mobile companion](https://www.onorca.dev/docs/mobile). The steps, for a
Linux host reached as `build-box` at a private address `100.64.1.20`:

1. Install Orca from its release package for the host (on Debian and
   Ubuntu the `.deb`; the command is then `orca-ide`, since Linux desktops
   ship a screen reader named `orca`), and the agents (`claude`, `codex`)
   signed in as the host's user.
2. Install the server as a user service, which Orca writes itself
   (`systemd --user` on Linux, needing `loginctl enable-linger`):
   `orca-ide serve service install --port 6768 --pairing-address 100.64.1.20`.
   The server listens on every interface and has no bind option, so the
   host's firewall must admit the port from the private network only.
3. Pair a client. The service prints no pairing link; stop it, run
   `orca-ide serve --port 6768 --pairing-address 100.64.1.20` in a terminal,
   and on the client run
   `orca environment add --name build-box --pairing-code 'orca://pair?code=…'`
   with the link it printed (`--mobile-pairing` prints a code for Orca
   Mobile instead); then start the service again. Each client gets a
   revocable grant of its own.
4. Register each clone with the server, on the host:
   `orca-ide repo add --path ~/dev/my-service`, and its base when it is not
   `origin/HEAD`:
   `orca-ide repo set-base-ref --repo name:my-service --ref origin/develop`.

Then `--environment build-box --ssh build-box` opens worktrees there, and
the launcher's `orca` settings (`environment`, `ssh`) do the same.

## What it relies on in Orca

The tool reads these commands and answers of Orca's command-line tool, each
with `--json`, and `--environment <name>` for a server: `repo show` (the
repository's `id` and `path`), `repo add --path <clone>` (only when
`--clone-url` is given), `worktree list --repo id:<id>` (`worktrees[]`
with `id`, `path`, `branch`), `worktree create --repo id:<id> --name <name>
--base-branch <ref> --no-parent --setup skip [--comment] [--activate]`
(the created `worktree`), `worktree set --worktree id:<id> --linear-issue
<key>`, `agent launch --agent <id> --worktree id:<id> [--prompt]`, and
`worktree rm --worktree id:<id> [--force]`. An error comes back as
`{ ok: false, error: { code, message } }`; `repo_not_found` is read by
name. Orca's command is the one of the terminal Orca opened
(`ORCA_CLI_BIN_DIR`), else the one on the login shell's `PATH`, else the
macOS app's own copy. An Orca release that changes these is work for Jig.
