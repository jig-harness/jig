# The hub

**What problem this solves.** Several machines that dispatch the same
repositories each read the forge and the tracker for themselves, and none
sees what the others are doing. The [hub](../../GLOSSARY.md) is an optional
service they enroll in: it keeps one view of the forge and the tracker for
all of them. Without it, every host dispatches alone, as it does today;
nothing here is needed for that. The design is
[design/control-plane.md](../../design/control-plane.md).

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
| Webhooks | `/webhooks/<source>`, and 404 to everything else | `webhooks.listen`; a [tunnel](../../GLOSSARY.md) publishes this path and nothing else |
| Feed | the page and the change feed | a Unix socket only the front's user may open, or loopback with a secret the [private-network front](../../GLOSSARY.md) adds |

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
     socket: /home/jig-hub/.jig/hub/feed/feed.sock
     group: jig-front                    # the front's group; optional
   ```

   Every setting has a default: user `jig-hub`, database
   `~/.jig/hub/data`, `/v1/` on `127.0.0.1:7461`, webhooks on
   `127.0.0.1:7462`, the feed on `~/.jig/hub/feed/feed.sock`. Write paths
   in full: the container sees the same paths as the host.

   - `host.listen` and `webhooks.listen` take loopback (`127.0.0.0/8`,
     `::1`) and private-network addresses (`10.0.0.0/8`, `172.16.0.0/12`,
     `192.168.0.0/16`, `100.64.0.0/10` as a tailnet hands out,
     `fc00::/7`). `0.0.0.0`, `::` and public addresses are refused.
   - The feed takes either `socket` (with `group`, which opens it to the
     front's group as mode 0660; without it the socket is 0600) or
     `listen`, a loopback address, with `secret`, at least 32 characters,
     which the front sends as the `x-jig-front-secret` header.

   ```sh
   chmod 600 ~/.jig/hub/settings.yaml
   ```

3. **Install it**: `jig install hub` previews; `jig install hub --yes`
   installs. It refuses, writing nothing, when it runs as root, as another
   user than the settings name, or as the dispatcher's user (one whose Jig
   home holds `dispatch.yaml` or whose scheduler holds the dispatcher's job),
   and when the settings file or the database directory is readable by
   another user. A bare `jig install` never includes the hub.

   The install writes a resident job (`jig hub serve --scheduled`), started
   again within a minute of stopping, and stopping by itself when the
   installed plugin copy or the settings file changes, so it restarts on the
   new copy. Where podman (preferred, rootless) or docker is installed, it
   first builds the hub's container image locally from the installed
   release, tagged `jig-hub:<version>`, and never pushes it anywhere; the
   job runs `jig hub serve` in it:

   - the settings file mounted read-only at `/run/jig-hub/settings.yaml`;
   - the database directory and the feed socket's directory mounted
     read-write at their own paths;
   - the host's network (`--network=host`), so the listeners bind exactly
     the host addresses the settings name and no port is published beyond
     them;
   - the hub user's uid and gid, and a read-only root filesystem.

   With neither tool installed the job runs `jig hub serve` directly. On a
   machine of its own that is enough; on a machine that also runs agent
   sessions, install podman so the hub runs in its container.

4. **Check it**: `jig doctor hub` checks the OS user, that the settings
   file is 0600 and the database directory 0700, both owned by the hub's
   user, that every listener is on loopback or the private network, and
   warns when no container tool is installed. It fails when either file is
   readable by another user.

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

In this order:

1. Stop the hub: `jig uninstall hub --yes` (the database stays).
2. Revoke the App's private key on GitHub and make a new one.
3. Rotate every webhook secret.
4. Revoke the tracker application's tokens and rotate its secret.
5. Make a new identity key, which voids every host's pin, credential and
   watch credential, so each host enrolls again.
6. Delete the database's copies of host records and the world view, which
   come back on their own.
7. Start the hub (`jig install hub --yes`) and approve the hosts again,
   checking each request's details.

The audit trail says who held what before.
