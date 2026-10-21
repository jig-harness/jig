# Herdr workspace tool

Starting an agent on a piece of work takes several steps that are easy to get
subtly wrong when done by hand or by a quick script: pick or create the
branch without forking one that already exists on the remote, check it out
as its own worktree, set up the worktree, start the agent, and hand it its
first prompt. Run the same steps again (a retry after a dropped connection,
a second click on "open") and a naive script makes a second worktree beside
the first, or sends the prompt again to an agent already halfway through the
work. This tool does those steps for [Herdr](https://herdr.dev), the
[workspace runtime](../../GLOSSARY.md) Jig's tooling targets first
([ADR-0005](../../docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)),
on the machine Herdr runs on or on a remote host over
[SSH](../../GLOSSARY.md), and opening the same work twice ends in the same
place as opening it once.

It is machine tooling, like the [launcher](../launcher/README.md), which
uses it as its `herdr` provider: it runs from a checkout of this repository,
not from the plugin.

## What it does

```sh
bun tools/herdr/workspace.ts [--host <ssh-target>] open --repo <clone> --branch <name> \
    [--base <ref>] [--label <text>] [--agent <kind>] [--no-agent] \
    [--prompt <text> --key <key>] [--wait-timeout-ms <ms>] [--json]
bun tools/herdr/workspace.ts [--host <ssh-target>] remove --repo <clone> --branch <name> [--force]
```

**`open`** creates the branch's worktree in the clone, or reattaches to the
one that has it:

1. It looks for a worktree on the branch in both Herdr's list and the
   clone's own `git worktree list`, since a worktree made with plain git is
   only in the second; when they disagree it stops. The clone's primary
   checkout is never used as a worktree.
2. With none, it decides where the branch comes from: origin's copy, a local
   branch origin does not have, or a new branch cut from `--base` (the
   clone's `origin/HEAD` by default) after fetching it. A local branch with
   commits origin lacks stops the run: a person decides which side wins.
   Every git check that cannot answer (a network error, a timeout) is an
   error, never read as "absent".
3. It sets the branch to track its origin copy, waits for the repository's
   create hook (below) and starts the agent (`claude` unless `--agent` names
   another [Herdr agent kind](https://herdr.dev/docs/cli-reference/)). A
   reattached workspace whose agent is running keeps it; one without gets
   the agent in a new tab, since its first pane may be running something.
   An agent that stops at a first-run or trust dialog is reported, with a
   Herdr notification, and left for a person to answer.
4. With `--prompt`, it sends that first prompt (the [kickoff](../../GLOSSARY.md)) once per
   `--key`, as below.

**`remove`** runs the repository's remove hook inside the worktree, parks
the worktree's unsent [reflection](../../plugin/skills/reflect/README.md)
findings, and only then removes the worktree through Herdr. When either step
fails the worktree stays. `--force` removes a worktree with uncommitted
changes, which git refuses otherwise.

**`--host`** runs the command on that machine over SSH. The tool is bundled
into one script and handed to `bun` on the host's standard input, so the host
needs `bun`, `git` and `herdr` on the `PATH` of a non-interactive SSH session
and an SSH key the caller can use without a prompt, and nothing from Jig: no
checkout to install or keep at the caller's version. A path starting `~/` is
resolved on the host.

Each command holds itself to a time limit
([`limits.ts`](limits.ts)): every git and Herdr call, hook run and pause is
cut to the time left, so a run ends at its limit, saying so, however many
steps it took. The SSH session of a `--host` run, and the launcher's budget,
are that limit plus two minutes for the connection, so neither ends a run
the tool allows.

Exit codes: 0 done; 1 a step failed, and the message says what to do; 2
usage.

## Sending the kickoff once

The kickoff goes to the agent once per key, whatever happens around it:

- **A claim** in `~/.jig/herdr/kickoff/claims/<key>/` marks a kickoff in
  flight and names the process holding it. A second launch of the same key
  waits for it (two minutes), and takes it over only once that process has
  ended: a launch that is merely slow may still be about to send, so no age
  makes a claim abandoned. A claim held on another host, or one whose owner
  cannot be read, is never taken over; the refusal names its directory, for
  a person to remove once no launch holds it. A claim is taken over
  by creating the next numbered one, never by deleting the old one, and a
  released claim stays on disk marked released, so numbers never repeat and
  two launches cannot both take one.
- **A receipt** in `~/.jig/herdr/kickoff/receipts/<key>/<agent>/` records a
  kickoff with the agent's name and, when Herdr reports one, its session id.
  Each agent a key was opened in (another clone's worktree has another
  agent) keeps its own, so opening the key in one never overwrites another's. The
  session id tells a restarted agent with the same name apart from the one
  that received the prompt. It is written as pending before the prompt is
  sent and completed once Herdr accepts it, so every send the tool attempted
  leaves a record, and one whose outcome is unknown stays pending. Each
  launch writes a file of its own, named by its claim's number, and the
  highest number is the receipt, so a launch whose claim was removed by hand
  and finishes late never replaces the record of the launch that took over.
  A receipt the tool cannot read as one of its own (empty or cut short) stops
  the tool rather than counting as none.
- **The transcript** confirms a pending receipt: the prompt's first line in
  the agent's recent output means it was delivered. Its absence proves
  nothing, since only recent output is read, so a pending receipt it does not
  confirm stops the tool. With no receipt at all, the transcript only spots a
  kickoff sent some other way.

When a reattach finds the agent running, or starts it by resuming its earlier
session, these decide whether to send. When they cannot (the session could
not be read, it changed since the agent started, a file cannot be read, a
pending receipt the transcript does not confirm, a send whose outcome is
unknown), the tool stops and says what to check rather than guess. Only an
answer from Herdr that it wrote nothing (the agent is at a dialog, there is
no such agent, a usage error) counts as not sent; a timeout or any other
error keeps the pending receipt, so no retry can send twice.

Herdr reports a session id only for an agent whose
[integration](https://herdr.dev/docs/) is installed (`herdr integration
install claude` on the host). Without it the tool still works, and says
that a restarted agent cannot be told apart from the original.

## The worktree hooks

[M12](../../modules/M12-parallel-agent-ergonomics/README.md) brackets each
worktree with a create hook (set it up: ports, dependencies) and a remove
hook (nudge reflection). A repository supplies them as executables at fixed
paths, read from the worktree, so each branch runs its own version. Opening
a branch therefore runs its code, as the hook's dependency install and the
agent working in it do anyway: open only branches whose code you would run.

| Path | Runs | Working directory |
|------|------|-------------------|
| `.config/worktree-hooks/create` | once, when the worktree is created | the new worktree |
| `.config/worktree-hooks/remove` | before `remove`; a failure keeps the worktree | the worktree being removed |

The [M12 hook templates](../../modules/M12-parallel-agent-ergonomics/templates/worktree-hooks.md)
are a starting point for both.

Herdr announces each new worktree with its `worktree.created` event, which
the plugin in [`plugin/`](plugin/herdr-plugin.toml) answers by running the
create hook. The event runs in the background, so `open` waits for the hook
to finish before it starts the agent: the hook runs under a claim in the
worktree's git directory, and whoever takes it first runs it. Each hook
runs under a small `bun` supervisor that starts it in a session and process
group of its own and ends that whole group when the hook fails, when it
outlives its 15 minutes, or when the tool that started it has gone (killed by
a launcher's or SSH session's deadline, say). The claim names both its owner's process and that
group, so a waiter on the same machine runs the hook again only once the
owner and every process of the earlier run have ended without a result. A
failed run's leftover processes are ended before its claim is given back. Without the
plugin, `open` runs the hook itself after a few seconds; a worktree made in
Herdr's interface then gets its create hook only when the plugin is
installed. A failed create hook stops `open` and runs again on the next one.

Herdr's `worktree.removed` event comes after the checkout is gone, too late
to run anything in it, so removal goes through `remove`.

## Install on the Herdr machine

```sh
herdr plugin install jig-harness/jig/tools/herdr/plugin   # the create-hook plugin
herdr integration install claude                          # session ids, per agent kind used
```

The plugin runs `bun` from the Herdr server's `PATH`. Nothing else is
installed per repository: a repository opts in by adding its hooks.

## What it keeps

Under `~/.jig/herdr/` (`JIG_HOME` moves `~/.jig`), outside every worktree so
removing one never takes them: `sessions/<agent>` (the session a later start
resumes, for agent kinds that take `--resume`), `kickoff/receipts/<key>/<agent>/`
and `kickoff/claims/<key>/`. Inside each worktree's git directory, `jig/worktree-create.*`
records the create hook's claim and result.

## The Herdr interface it relies on

The tool calls Herdr's command line and reads its JSON
([ADR-0005](../../docs/adr/ADR-0005-herdr-is-the-primary-workspace-runtime.md)
names this as a dependency), checked against Herdr 0.8:

- `worktree list --cwd`, `worktree create`, `worktree open --path` (which
  answers with the workspace and its first pane whether or not it was
  already open) and `worktree remove --workspace`;
- `tab create`, `agent start`, `agent wait`, `agent get` (whose
  `agent_session` is absent without an integration), `agent read`,
  `agent prompt` and `notification show`;
- an error is a JSON envelope `{"error":{"code","message"}}` on stderr with
  exit 1; a usage error exits 2;
- `agent prompt` takes `--timeout` only with `--wait`, so the kickoff is sent
  without either and bounded by its process deadline; it answers
  `agent_blocked` without writing anything, while a timeout does not show
  that nothing was delivered;
- the `worktree.created` plugin event's `HERDR_PLUGIN_EVENT_JSON` names the
  worktree at `data.worktree.path`, and the event's command runs in the
  plugin's directory.
