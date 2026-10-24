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
    [--comment <text>] [--linear-issue <key>] [--activate] [--json]
bun tools/orca/workspace.ts remove --repo <name> --branch <name> [--environment <name> --ssh <host>] [--force]
```

`--repo` is the repository's name in Orca (`orca repo list`), on the machine
Orca runs on. **`open`** creates the branch's worktree through Orca, or
reattaches to the checkout that already has the branch. With
`--reuse-prefix`, which `--branch` must start with, it first chooses the
branch: the one existing branch, local or on origin, whose name starts with
it is opened instead of `--branch`, so work started under an earlier name
keeps its branch; several stop the run unless `--branch` is one of them.
Then:

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
   point, with Orca's own setup hook skipped, and then **names the branch**:
   Orca names a new branch after the worktree under its own prefix
   (`<git user>/feature-eng-12-fix-the-login` for a worktree named
   `feature/ENG-12-fix-the-login`), so the tool renames a fresh branch, or
   checks out the existing one and deletes Orca's, and sets the branch to
   track its origin copy. Orca reads the branch from git, so it follows, and
   `--worktree branch:<name>` selects the worktree from then on.
4. It runs the repository's create hook (`.config/worktree-hooks/create`,
   [M12](../../modules/M12-parallel-agent-ergonomics/README.md)) inside the
   worktree, once: a run that succeeded leaves a mark in the worktree's git
   directory (`jig-orca-create-hook`), and one that failed stops the open
   and leaves none, so the next open runs the hook again. The hook runs after
   the branch has its name, since a hook may read it.
5. It starts the agent (`claude` unless `--agent` names another Orca agent
   id) in the worktree with `--prompt` as its first prompt, once per
   `--key`, as below. `--linear-issue` links the issue to the worktree in
   Orca's Linear integration; when that integration is not connected the
   link only warns. `--comment` is kept in Orca's metadata, and `--activate`
   reveals the new worktree in the app.

**`remove`** runs the repository's remove hook inside the worktree, parks the
worktree's unsent [reflection](../../plugin/skills/reflect/README.md)
findings, and only then removes the worktree through `orca worktree rm`.
When either step fails the worktree stays. `--force` removes a worktree with
uncommitted changes, which Orca refuses otherwise. Orca also deletes the
worktree's local branch when it can tell the branch is merged, and keeps it
otherwise. Parking runs the reflection journal in this process, so it
happens only when the clone is on this machine: on a server's host, the tool
says so, and the findings are parked by running `/jig:reflect` there first.

**`--environment`** names a paired Orca server (`orca environment list`), so
Orca's tool runs here and reaches the server, and the worktree is created on
the server's machine. Git and the hooks must run where the clone is, so
`--ssh` names that machine's SSH destination, which needs `git` on the
`PATH` of a non-interactive SSH session and an SSH key the caller can use
without a prompt, and nothing from Jig. A path Orca reports is a path on the
server.

Each command holds itself to a time limit: every git and Orca call and hook
run is cut to the time left, so a run ends at its limit, saying so, however
many steps it took. `open` allows for the create hook (15 minutes, since a
dependency install is slow) and the calls around it; the launcher's budget
is that limit plus the connection around it.

Exit codes: 0 done; 1 a step failed, and the message says what to do; 2
usage.

## Starting the agent once

Orca does not say whether an agent in a worktree already received a prompt,
so the tool keeps its own record, a **receipt** in
`~/.jig/orca/kickoff/<server>/<key>.json` (`local` for Orca on this
machine; `JIG_HOME` moves `~/.jig`), written on the machine the tool runs
on:

- An open with a `--key` and no receipt writes one as pending, starts the
  agent, and completes it with Orca's answer. The next open of the same key
  finds it and starts nothing, whether it created the worktree or
  reattached, and says where the agent was started.
- A pending receipt means an earlier open started the agent and never
  learned the outcome (the launch was cut short). The tool stops and says to
  look at the worktree in Orca and delete the file if the agent never
  started, rather than start a second one.
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
repository's `id` and `path`), `worktree list --repo id:<id>` (`worktrees[]`
with `id`, `path`, `branch`), `worktree create --repo id:<id> --name <name>
--base-branch <ref> --no-parent --setup skip [--comment] [--activate]`
(the created `worktree`), `worktree set --worktree id:<id> --linear-issue
<key>`, `agent launch --agent <id> --worktree id:<id> [--prompt]`, and
`worktree rm --worktree id:<id> [--force]`. An error comes back as
`{ ok: false, error: { code, message } }`; `repo_not_found` is read by
name. Orca's command is the one of the terminal Orca opened
(`ORCA_CLI_BIN_DIR`), else the one on the login shell's `PATH`, else the
macOS app's own copy. An Orca release that changes these is work for Jig.
