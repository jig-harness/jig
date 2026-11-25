# The hub

**What problem this solves.** Several machines that dispatch the same
repositories each read the forge and the tracker for themselves, and none
sees what the others are doing. The [hub](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) is an optional
service they enroll in: it keeps one view of the forge and the tracker for
all of them. Without it, every host dispatches alone, as it does today;
nothing here is needed for that. The design is
[design/control-plane.md](https://github.com/jig-harness/jig/blob/main/design/control-plane.md).

This page is for the person who runs a hub on their own machine, with the
process adapter: `jig hub serve` on Bun, its database a SQLite file. It
covers setting it up, upgrading it, backing it up, rotating its secrets and
recovering it after a compromise. Enrolling hosts and receiving webhooks
come in later releases.

## What runs

`jig hub serve` runs three listeners, kept apart, each answering only its
own paths:

| Listener | Paths | Where it listens |
| --- | --- | --- |
| Host protocol | `/v1/` | the addresses in `host.listen`: loopback and the private network's interface only, never every interface |
| Webhooks | `/webhooks/<source>`, and 404 to everything else | `webhooks.listen`; a [tunnel](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) publishes this path and nothing else |
| Feed | the page and the change feed | a Unix socket only the front's user may open, or loopback with a secret the [private-network front](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) adds |

Its background work (trimming old rows, and later the reconciliation
sweep) runs as scheduled jobs. Each job's next run is kept in the database,
so a restarted hub runs it when it was due, and every run happens in a
worker thread with its own database connection: a long run never delays a
webhook's acknowledgement or a host's call.

## Setting it up

The hub runs under an OS user of its own, `jig-hub` by default, never as
root and never as the user whose dispatcher runs on the same machine. A
session the dispatcher starts reads untrusted pull-request and issue text,
so it must never reach the hub's settings or its database.

1. **Create the user** and let its jobs run after logout. On Linux:

   ```sh
   sudo useradd --create-home --shell /bin/bash jig-hub
   sudo loginctl enable-linger jig-hub
   ```

   On a machine with no other users, an existing user works too, as long
   as it is not the dispatcher's.

2. **As that user**, install the plugin (`jig upgrade` installs it into
   Claude Code or Codex) and write the settings file,
   `~/.jig/hub/settings.yaml`, mode 0600:

   ```yaml
   user: jig-hub                         # the OS user the hub runs as
   database: /home/jig-hub/.jig/hub/data # created mode 0700
   host:
     listen: [127.0.0.1:7461, 100.101.102.103:7461]
   webhooks:
     listen: 127.0.0.1:7462
   feed:
     socket: /home/jig-hub/.jig/hub-feed/feed.sock
     group: jig-front                    # the front's group; optional
   ```

   Every setting has a default: user `jig-hub`, database
   `~/.jig/hub/data`, `/v1/` on `127.0.0.1:7461`, webhooks on
   `127.0.0.1:7462`, the feed on `~/.jig/hub-feed/feed.sock`. Write paths
   in full: the container sees the same paths as the host.

   - `host.listen` and `webhooks.listen` take loopback (`127.0.0.0/8`,
     `::1`) and private-network addresses (`10.0.0.0/8`, `172.16.0.0/12`,
     `192.168.0.0/16`, `100.64.0.0/10` as a tailnet hands out,
     `fc00::/7`). `0.0.0.0`, `::`, link-local addresses (`fe80::/10`,
     which reach only the link, not a private network) and public
     addresses are refused.
   - The feed takes either `socket` (with `group`, the front's group) or
     `listen`, a loopback address, with `secret`, at least 32 characters,
     which the front sends as the `x-jig-front-secret` header.
   - The socket's directory decides who reaches the socket. Without
     `group` it is mode 0700, the hub user's alone, and the socket 0600.
     With `group`, `jig install hub` gives the directory that group and
     mode 0710, so the front's user may pass through it but not list it,
     and the hub opens the socket inside it to whoever reaches it (0666).
     Every directory above it must let the front's user pass too: the hub
     user's home is often 0750 or 0700, so give it the others' search
     permission (`chmod 711 /home/jig-hub`), or point `feed.socket` at a
     directory the front can reach. `jig install hub` and `jig doctor hub`
     name each directory in the way. The hub's own directory,
     `~/.jig/hub`, stays the hub user's alone, which is why the socket's
     default sits beside it.

     Create the shared group first, and add both the hub and front users to
     it, before naming it in `feed.group`.

   ```sh
   chmod 600 ~/.jig/hub/settings.yaml
   ```

3. **Install it**: `jig install hub` previews; `jig install hub --yes`
   installs. It refuses, writing nothing, when it runs as root, as another
   user than the settings name, or as the dispatcher's user (one whose Jig
   home holds `dispatch.yaml` or whose scheduler holds the dispatcher's job),
   and when the settings file or the database directory is readable by
   another user. A bare `jig install` never includes the hub.

   The install makes the database directory and the feed socket's
   directory, then writes a resident job (`jig hub serve --scheduled`),
   started again within a minute of stopping, and stopping by itself when
   the installed plugin copy or the settings file changes, so it restarts
   on the new copy. One runs at a time: a start while the hub runs leaves
   at once. Where podman or docker is installed, it first builds the
   hub's container image locally from the installed release, tagged
   `jig-hub:<version>`, and never pushes it anywhere; the job runs
   `jig hub serve` in it:

   - the settings file mounted read-only at `/run/jig-hub/settings.yaml`;
   - the database directory and the feed socket's directory mounted
     read-write at their own paths;
   - on Linux, the host's network (`--network=host`), so the listeners bind exactly
     the host addresses the settings name and no port is published beyond
     them; it also lets the hub reach the services the host listens for on
     loopback;
   - the hub user's uid and gid, and a read-only root filesystem.

   Container mode currently requires Linux host networking. On macOS and
   other platforms the job runs `jig hub serve` directly.

   Prefer podman, rootless: to run containers with docker, the hub's user
   joins the `docker` group, and that group can do anything as root on the
   machine, so the hub's user would effectively hold root.

   With neither tool installed the job runs `jig hub serve` directly. On a
   machine of its own that is enough; on a machine that also runs agent
   sessions, install podman so the hub runs in its container.

4. **Check it**: `jig doctor hub` checks the OS user, that the settings
   file is 0600 and the database directory 0700, both owned by the hub's
   user, that every listener is on loopback or the private network, that
   the feed socket's directory has its mode and group and the front can
   reach it, and warns when no container tool is installed. It fails when
   either file is readable by another user.

`jig hub serve --settings <file>` runs the hub in the foreground, for a
first try; it stops on Ctrl-C.

## Upgrading

Upgrade the hub before its hosts: a host and its hub agree on the protocol
by plugin version. As the hub's user, `jig upgrade` moves the plugin to the
new release; the resident job notices the new installed copy within a
minute, stops and starts again on it, building the new release's image
first when it runs in a container. Run `jig install hub --yes` again after
an upgrade when you want the image built before the job restarts.

## Backups

The database is one SQLite file, `hub.sqlite`, in the database directory.
Until the hub has its own backup command, copy it consistently with
SQLite's online backup, as the hub's user:

```sh
sqlite3 ~/.jig/hub/data/hub.sqlite ".backup '/backups/hub-$(date +%F).sqlite'"
```

or stop the job, copy the directory and start it again. Most of what the
hub holds comes back on its own from the forge and the tracker; the
settings file, which holds its secrets, is backed up apart, encrypted.

## Rotation

Rotate the webhook secrets and the forge App's private key once a year, and
at once on suspicion. The hub will accept two webhook secrets per source
while one replaces the other, and the forge holds two App keys at once, so
neither rotation drops a delivery. The commands come with webhook intake.

## Recovering from a compromise

The shipped hub has no enrollment, webhook, forge, tracker, identity-key or
host-approval commands yet. Stop a suspected hub with
`jig uninstall hub --machine --yes`; it removes the job and stops the running
process while keeping the database for investigation. Rotate credentials in
the services that issued them, preserve the database and settings file as
evidence, then reinstall the hub after the affected settings have been
replaced. Host enrollment and recovery audit records arrive with those
features.
