# Open the dispatch dashboard from a phone

The [dispatch dashboard](README.md#the-dispatcher) is one page that says
what waits for a person. Away from the computer, a phone is where that
page is wanted most, and the plain way to reach it has a flaw: the
dashboard's address carries a secret token, so the address sits in the
browser's history, and a page loaded over plain HTTP to another machine is
not a [secure context](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), so the browser withholds the
clipboard from it. Without a guide, a person either pastes a token into a
phone or gives up on the phone.

This guide sets up the better path: a **private HTTPS address** that opens in
the phone's ordinary browser with no token in it, put in front of the
dashboard by a [private-network front](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md). It also describes the
plain private-HTTP fallback and what it costs. Neither path writes
anything: the page only reads, and nothing here sends a command or changes a
pull request through Jig.

Who it is for: the person who owns the host that runs the dashboard. Every
step runs on that host, except the checks on the phone.

## What the phone gets

The phone's scope is the one [the dashboard design](https://github.com/jig-harness/jig/blob/main/design/dispatch-dashboard.md#phone-scope-and-access)
fixes: Merge, Needs you, Running, Queue and History; an opened decision;
copying a command or an answer line; and links to the forge and the tracker.
It excludes chat, steering and every write.

**Stage 1 has no per-repository viewer grants.** A front here authenticates
one owner, and that owner sees the dashboard's complete state root: every
repository the machine file lists, as
[the board's reader boundary](https://github.com/jig-harness/jig/blob/main/design/dispatch-board.md#who-reads-it)
describes. To keep repositories apart, run a dashboard per state root. Do not
let a second person through the front expecting a narrower page.

## Before you start

1. **The reader runs on its own.** Install needs a fixed listen port, so the
   machine file must already set `dashboard.listen` (for example
   `127.0.0.1:8765`, as the Serve section below does). Set it first if it is
   absent. Then install the dashboard's retry timer so the page survives
   logout and reboot, and check it:

   ```sh
   jig dispatch dashboard --install --yes
   jig dispatch dashboard --status
   ```

   The [availability contract](README.md#the-dispatcher) names the
   prerequisites (a Linux service manager with lingering, or cron) and how
   to check recovery. Install it before the front: a front on a reader that
   stops with a terminal is a link that breaks overnight.

2. **Know what already routes to the dashboard's port.** Tokenless serving
   (below) is only safe when the front is the only way in. List what the
   host already publishes:

   ```sh
   tailscale serve status
   ```

   A route that forwards raw network connection to the port the dashboard will use, such as
   a forward of tailnet port 8765 to `127.0.0.1:8765` that exists for the
   private-HTTP fallback, would hand the page to every device it reaches
   with no token. Remove that route first, with its own `off` command, and
   only that one. The steps below never run `tailscale serve reset`, which
   removes every route, including ones that belong to other services.

3. **Know who your private network lets in.** A tailnet front reaches
   whichever devices the tailnet's access policy allows to connect to this
   host. On a tailnet with other people or shared devices, confirm in its
   admin console that only your own devices may reach the host's HTTPS port
   the front will use. Tailscale enforces that policy; Jig neither reads nor
   changes it, so you verify it yourself, and that choice stays with the
   person who owns the network.

## Recommended: Tailscale Serve

[Tailscale Serve](https://tailscale.com/kb/1312/serve) publishes a local
server to your private network (a *tailnet*) over HTTPS with a certificate
Tailscale obtains, and only devices the tailnet admits can connect. It is the
first implementation of the front; the next section covers a browser path
without it.

1. **Turn on the certificate.** HTTPS certificates must be enabled for the
   tailnet in its admin console, and its automatic host names must be on. The host's name,
   `<host>.<tailnet>.ts.net` below, then appears in public certificate logs.

2. **Point the dashboard at loopback and let the front authenticate.** In the
   machine file:

   ```yaml
   dashboard:
     listen: 127.0.0.1:8765
     require_token: false
     allowed_hosts: [<host>.<tailnet>.ts.net]
     front: https://<host>.<tailnet>.ts.net:8443/
   ```

   `require_token: false` is accepted only with a loopback `listen`, so the
   page is unreachable from any other machine except through the front.
   `allowed_hosts` lists the names the front forwards requests under, and
   nothing wider: the dashboard answers 403 to any other `Host`, which keeps
   a page on another origin from reading it. If the front rewrites the
   `Host` header to a name the dashboard already allows, leave
   `allowed_hosts` alone. Another front or another name needs its own
   entry, and stays out otherwise. `front` is the address the front
   publishes in step 3, with the port you choose there; the dashboard does not
   serve on it, it only prints it for the phone (step 5). It is refused
   unless it is an `https:` address with no token, password, query or
   fragment in it. The reader stops when its configuration changes and the
   timer starts it again (allow up to two minutes); check with `--status`.

3. **Publish it on a separate HTTPS port.** Port 443 may already serve
   something else, so pick an HTTPS port and root path no existing route
   uses. 8443 below is an example. Read `tailscale serve status` first: serving
   the same port and path again replaces that route's handler. Use the port
   you chose in every command below, in the checks and in the undo.

   ```sh
   tailscale serve --bg --https=8443 http://127.0.0.1:8765
   tailscale serve status
   ```

   The existing routes appear unchanged in the status beside the new one.
   The address is `https://<host>.<tailnet>.ts.net:8443/`, with no token.

4. **Check it works, then check it refuses.** From the host:

   ```sh
   curl -sS -o /dev/null -w '%{http_code}\n' https://<host>.<tailnet>.ts.net:8443/
   curl -sS -o /dev/null -w '%{http_code}\n' -H 'Host: other.example' http://127.0.0.1:8765/
   ```

   The first answers `200`; the second answers `403`, which is the allowlist
   working. The page makes no request that needs a header from the front:
   the dashboard reads no identity header, so a client-supplied one grants
   nothing.

5. **Open it from a second device.** To carry the address to the phone,
   print it:

   ```sh
   jig dispatch dashboard --access
   ```

   It prints the `front` address as text and, below it, a
   [QR code](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) (a
   square barcode a phone camera reads) of the same address. The code holds
   only the address, never a token: scanning it opens the page, and the front
   still decides who may see it. The text is the fallback when scanning
   fails, and the only output into a pipe or a terminal that cannot draw the
   code. The code is drawn light on dark, which reads best on a terminal with
   a dark background; most phone cameras also read it inverted. With the
   phone signed in to the tailnet, scan the code or type the address in the
   phone's ordinary browser. Confirm the browser shows an address with no
   token in it, and bookmark it. Then run the [phone checks](#phone-checks).

## Without Orca or Tailscale: an authenticated reverse proxy

Any [reverse proxy](https://en.wikipedia.org/wiki/Reverse_proxy) that
terminates HTTPS and signs the owner in first does the same job. What it
must do, whatever the product:

- **Authenticate the owner before forwarding**, with an identity provider the
  owner controls, and answer an unauthenticated request with a sign-in
  redirect or `401`, never with the page.
- **Listen only on a private address** and forward to the dashboard's loopback
  `listen` address. It never publishes to the open internet. Many proxies bind
  every interface by default, so name the private interface explicitly.
- **Forward the public `Host`**, and put that name in `allowed_hosts` as
  above, or send a `Host` the dashboard already allows.
- **Name its address as `dashboard.front`** (`https://jig.example.net/` in
  the example below), so `jig dispatch dashboard --access` prints it and its
  QR code for the phone.
- **Drop identity headers a client sends**, and set its own from the sign-in
  (copy only fields the sign-in service verified).
  The dashboard ignores them, but a proxy that lets them through teaches the
  next service behind it to trust them.
- **Use a certificate the phone trusts**, from a public authority through a
  domain-ownership challenge or from a private authority the phone has installed. A
  warning page defeats the secure context this setup exists for.

An example of the shape, for Caddy with an `oauth2-proxy` sign-in on
`127.0.0.1:4180` (a sketch, not a tested configuration, and not part of the
[verification record](#verification-record)). Replace `<private-address>` with
an address of the host's private interface (a Tailscale address, say; `tailscale
ip -4` prints it), so the site is not bound to every interface. A site on a private address
cannot pass Caddy's default certificate challenges, which need the host
reachable from the public internet, so the sketch supplies the certificate
itself: the `tls` line takes a certificate and key you provisioned beforehand,
or you replace it with a
[DNS challenge](https://caddyserver.com/docs/automatic-https#dns-challenge),
which needs a Caddy build with your DNS provider's module and an API token for
the domain:

```text
jig.example.net {
	bind <private-address>

	# a certificate the phone trusts, provisioned beforehand; or replace this
	# line with a `tls { dns <provider> ... }` block for a DNS challenge
	tls /path/to/fullchain.pem /path/to/privkey.pem

	# sign-in start and callback paths go to the sign-in service itself,
	# unchecked, so a browser without a session can obtain one
	handle /oauth2/* {
		reverse_proxy 127.0.0.1:4180
	}

	handle {
		forward_auth 127.0.0.1:4180 {
			uri /oauth2/auth
			# a 401 sends the browser to sign in instead of showing an error
			@unauth status 401
			handle_response @unauth {
				redir * /oauth2/sign_in?rd={scheme}://{host}{uri} 302
			}
		}
		reverse_proxy 127.0.0.1:8765 {
			# never pass through identity headers a client supplied
			header_up -Tailscale-User-Login
			header_up -X-Forwarded-User
			header_up -X-Forwarded-Email
		}
	}
}
```

Jig does not ship a proxy and does not install one.

## Phone checks

Run these on the phone, in its ordinary browser, after either front. A check
passes only when the result is the one in the table.

| Check | Result |
| --- | --- |
| Open the address from a device the front admits | The page loads over HTTPS with no certificate warning and no token in the address bar |
| Open it from a device or sign-in the front does not admit | No page and no data: a refused connection, a sign-in page or `401` |
| Send a made-up identity header to the front from such a device (for example with `curl -H 'Tailscale-User-Login: someone@example.com'`) | Still refused |
| Open a decision on Needs you and read its question, recommendation and alternatives | The whole decision is readable without horizontal scrolling |
| Tap a copy control on a merge command or an answer line | The page confirms the copy, and pasting elsewhere gives the complete line |
| Refuse the browser's clipboard permission, then tap copy again | The page offers the complete text for selecting by hand |
| Tap a pull request or issue link | The forge or tracker opens in its own page and its own sign-in |
| Open the menu in Chrome and choose Install app (tokenless path only) | The offer appears, the installed app opens in its own window with no browser bar, and no token is in any address it shows, and copying a command still works |

Copying only puts text in the clipboard. Neither path sends a command or
writes anything through Jig.

## Fallback: private HTTP

Where no front is set up, the dashboard can serve a phone directly:

1. In the machine file, set `dashboard.listen` to the host's private address
   (a Tailscale address, say) and **leave `require_token` on**.
2. Join the phone to the same private network, then print the address with
   `jig dispatch dashboard --access` and carry it to the phone by a private
   channel. It draws no QR code for this address: the address carries the
   token, and a code of it would show the credential to any camera that sees
   the screen.

What it costs:

- **Network membership is the lock.** Anyone on that private network who
  holds the address can read the dashboard; the token is the second factor.
- **The address is a credential.** It stays in browser history, in synced
  history and in screenshots. Do not post it. A phone's browser history is
  exactly where it ends up.
- **Restarting the dashboard revokes it.** The token is minted when the reader
  starts and rotates when it renews, so after a restart `--access` prints a
  new address and the old one stops working.
- **It is not a secure context.** The network's encryption does not give the
  browser one, so the clipboard API is withheld. Reading and links work, and
  selecting the text by hand is the way to copy.

## Install it as an app

On the HTTPS path without a token, the page offers itself to the phone's
browser as an app: it names a [web app manifest](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) and its icons, and Chrome on
Android then lists **Install app** in its menu. The installed app opens in its
own window with no browser bar, from the home screen, and shows the same
read-only page.

What makes it work, and what it does not:

- **It needs the tokenless path.** The installed app always starts at the
  dashboard's root address, with no token, which is why a server that asks for
  a token does not offer it: it refuses the manifest as it refuses every
  request without the token, and the browser shows no install option. The
  private-HTTP fallback is neither a secure context nor token-free, so it
  never offers install either.
- **The front must let the manifest and the icons through.** They are
  ordinary requests to the same address, and the page asks the browser to send
  its cookies with the manifest request, so a front that keeps its sign-in in
  a cookie passes it for a phone that is signed in. A front that answers a
  request without a session with a sign-in page, and one the phone cannot
  satisfy for these requests (a sign-in the browser does not repeat on its own),
  leaves the browser reading a page where it expects JSON, and no install is
  offered.
- **It is a launcher, not a second copy.** The app has no offline mode and no
  [service worker](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md). A window that is already open when the host goes off marks
  its facts stale and offers Retry; starting the app while the host is off, or
  while the phone is off the private network, shows the browser's own
  connection error.
- **It does not turn on web push.** HTTPS gives the page a secure context and
  nothing more; notifications are a separate feature this setup does not ship.

To install: open the HTTPS address in Chrome on the phone, open the menu and
choose **Install app**. Remove it the way the phone removes any app; nothing is
written to the host. Run the install row of the [phone checks](#phone-checks).

Never make a home-screen shortcut from an address that carries a token, such as
the private-HTTP fallback's. Chrome offers one even where it offers no install,
and the shortcut keeps the whole address, token included, on the home screen.

A host that is off cannot answer. A phone then gets a connection error, and a
page that was already open marks its facts stale and offers Retry. A watcher
outside the host is [out of scope](https://github.com/jig-harness/jig/blob/main/docs/adr/ADR-0013-records-not-a-daemon.md).

## Undo it

Removing the front touches nothing else:

1. `tailscale serve --https=8443 --set-path=/ off` removes only the root
   route this guide added, on the port you chose; other mounts on that port
   stay. Run `tailscale serve status` and check every other route is still
   listed. For a reverse proxy, remove its site block and reload it.
2. In the machine file, delete `require_token: false`, `front` and the entry
   added to `allowed_hosts`, and set `listen` back to its earlier private
   address if the fallback is wanted. The reader restarts on its own. If any route
   still forwards to the dashboard's port, restore the token first: a
   tokenless dashboard behind a route with no sign-in serves everyone it
   reaches.
3. Leave the retry timer and the tailnet settings as they are. They are
   separate: `jig dispatch dashboard --uninstall --yes` removes only the
   reader's timer.

## Verification record

A row is filled in by the person who ran the check, with the product versions
they used. A row with no result has not been run, and nothing in this guide
claims it works until it has.

| What was tested | Result |
| --- | --- |
| Front and version (`tailscale version`) | Not yet run |
| Phone browser and version | Not yet run |
| Ordinary-browser access to the HTTPS address, no token in it | Not yet run |
| Refusal for a device or sign-in the front does not admit | Not yet run |
| Forged identity header from a refused device | Not yet run |
| `Host` allowlist: `200` for the front name, `403` for another | Not yet run |
| Existing Serve routes unchanged after setup and after undo | Not yet run |
| QR code and text for the token-free address, scanned on the phone | Not yet run |
| Reading a decision, copying a command and an answer line, opening the forge link | Not yet run |
| Copy after the clipboard permission is refused | Not yet run |
| Install app offered in Chrome on the phone; the installed app opens in its own window, reads the page and copies a command | Not yet run |
| Reverse-proxy path, with its product and version | Not yet run |
