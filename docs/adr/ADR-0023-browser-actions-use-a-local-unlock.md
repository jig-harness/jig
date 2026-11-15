---
title: "ADR-0023: Browser actions use the person's credential and a local unlock"
type: adr
status: draft
description: "The overview's acts are writes the person's browser makes as the person, on the path the decision record of pull request #891 introduces, widened to the overview's acts, with a confirmation for each, no merge on a phone, an optional unlock that keeps the stored token encrypted through WebAuthn's key-derivation extension, and a scoped exception to the outbound-call rule for what a browser cannot record on a host"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-14
owner: maintainers
decision_date: 2026-11-14
supersedes: ~
superseded_by: ~
tags: [adr, dashboard, security, phone, integrations]
---

# ADR-0023: Browser actions use the person's credential and a local unlock

**Status:** Draft · **Date:** 2026-11-14 · **Deciders:** Jig's maintainers through pull-request review

## Context

The decision record pull request #891 introduces (ADR-0019 there, "The
dashboard's page answers a parked decision as the person") lets the
[dispatch dashboard](../../GLOSSARY.md)'s page post one kind of write: the
answer to a decision a drive (a pull request's review loop) parked for a
person. The page sends it from the person's
browser straight to the [forge](../../GLOSSARY.md) (the code host), with a
fine-grained token the person pastes into that browser and keeps in its
local storage. The host never receives the token or the request. Send works
on a phone as on a desktop, over HTTPS or from loopback.

The [overview design](../../design/priorities-and-overview.md) asks for more
acts on that path: answers to pickup and follow-up questions, release, hold,
re-arm (restart a drive) and assign, filing a prepared issue, approving a
[steward](../../GLOSSARY.md) proposal, and a merge. ADR-0019 there says to reopen it
when a [station](../../GLOSSARY.md) (a stage of the line, such as a pickup or
a follow-up) other than the drive reads an answer from a comment, which
these acts do. The dashboard's phone contract
([Phone scope and access](../../design/dispatch-dashboard.md#phone-scope-and-access))
allowed no phone write beyond that answer until a separate phone design
and proof of presence existed; this record and the overview design are
that design, and the section now says so. A phone is lost or lent more often than a desktop,
and a token kept in plain local storage is readable by anyone who opens the
browser.

Every call to an outside system must go through its
[governed transport](../../GLOSSARY.md)
([ADR-0021](ADR-0021-outbound-calls-are-governed.md)). That transport runs
on the host, and the page cannot write to the host, so some of its
obligations cannot be met from the browser as they are on the host.

## Decision

### What this keeps from the record pull request #891 introduces

- **The path.** Each act is one write made from the person's browser,
  directly to the forge or the tracker, as the person, with their own
  token. The dashboard's server gains no write route and never receives the
  token, the request or the answer
  ([ADR-0013](ADR-0013-records-not-a-daemon.md)).
- **The token.** A fine-grained token, pasted once per browser, tested by
  asking the forge whom it signs in as, limited to the dashboard's
  repositories and the rights its acts need, with a short expiry, forgotten
  on request.
- **Where the page sends.** Only over HTTPS or from loopback. The phone
  reaches the host through the private-network HTTPS front; on the plain
  HTTP fallback it sends nothing and stays read-only.
- **The page's defences.** The strict content security policy that runs
  only the page's own script, and text from records rendered as data.
- **Trust.** An act is trusted exactly as `jig send` from the person's
  terminal is, until the [pass trust boundary](../../GLOSSARY.md) (plan item 40: the mechanisms
  that tell a comment a pass posts under the person's login from the
  person's own) lands. A decision class whose answers need that proof (an
  [attested class](../../GLOSSARY.md)) keeps its existing requirements.
- **An answer sends only from a pick**, and is written by the module
  `jig send` writes it with.

### What this amends, and why

- **More acts.** The page may send the overview's acts in the order its
  design gives, not only a parked drive's answer, because each is one write
  of a kind the [line](../../GLOSSARY.md) (the dispatcher and the sessions
  it starts) already reads and checks. The File draft and the
  steward approval are the only new record kinds. No act marks an item or a
  step outside the code done: a follow-up checks the step's closing
  condition, or reads the person's answer, before it moves the item.
- **No merge on a phone.** A phone gets every other act. A merge cannot be
  undone and has no station on its far side to check it, so it stays on a
  desktop, behind its own confirmation, with a token that holds the right
  to merge.
- **The token's rights.** The record pull request #891 introduces limits
  the token to Issues and Pull requests. A desktop token that merges also
  needs the right to write the repository's contents; the settings panel
  names the rights each act needs and which of them the pasted token holds.
  A phone's token is created without the right to merge, so a lost phone,
  or a page that has been tampered with, cannot merge through the forge's
  API: the page's own refusal is not the only guard.
- **A confirmation for every act**, not only for a guarded pick. It shows
  the target, the act and exactly what will be sent, and a changed target
  invalidates it, because the wider acts change state that stations read.
- **The token at rest, under the unlock.** An optional local unlock uses
  WebAuthn (the browser standard for checking a person with the device's
  fingerprint, face or own unlock, [glossary](../../GLOSSARY.md)) and its key-derivation
  extension (the [PRF extension](../../GLOSSARY.md), which returns secret
  bytes bound to the credential). With the unlock on, the token is stored
  only encrypted, under a key derived from those bytes; a check of the
  person opens it into page memory for a session of 30 minutes by default,
  and expiry, an explicit lock or closing the page drops it. The unlock is
  on for a phone and off for a desktop by default; both, and the session's
  length, are settings. With it off, the token is kept as ADR-0019 there
  keeps it, in the browser's local storage, and the settings panel says it
  is not protected at rest. The page never falls back to that storage on
  its own: where the unlock is on and the browser or credential cannot
  return a usable key-derivation result, it says "Unlock unavailable", and
  only the person's turning the unlock off moves the token into plain
  storage. A real create, read and decrypt round trip is required before a
  token is stored under the unlock.
- **Linear after GitHub.** The content security policy adds the tracker's
  own API address when that tracker's acts ship.

### Outbound calls from the page

Each of [ADR-0021](ADR-0021-outbound-calls-are-governed.md)'s obligations
applies to a browser act, the answer Send ADR-0019 there introduces
included, as follows:

1. **One door.** The page has one module per outside system, built from
   the shared library's parts that run in a browser (the failure classes,
   deadlines, paging), and no other page code sends to that system. The
   module builds each request's address from a fixed API origin for the
   system's configured profile (the forge's or tracker's API host, over
   HTTPS), never from a URL a record, a comment or a reference carries; it
   refuses any other scheme or host before it attaches the token, and
   follows no redirect (a redirect answer is `server-fault`). Partly met:
   see the exception below.
2. **Reuse before sending.** The reads that prepare a confirmation (the
   target's revision, a duplicate search) are made once and reused by the
   send. A write whose answer was lost is read back, never sent again
   blind. Met.
3. **Admit before sending.** The balance that admits an act is the one of
   the credential that sends it. The page reads the pasted token's own
   balance from the system's rate-limit answers (the headers of each answer,
   and the forge's free rate-limit read, per resource: core, search,
   GraphQL) and refuses an act while it is below the share the
   [tick](../../GLOSSARY.md) (one run of the dispatcher) keeps for drives
   and people (`load.forge_floor` for the forge). The host's
   [budget record](../../GLOSSARY.md), carried in the read feed, is a second
   check only when it names the same signed-in login and resource as the
   token; otherwise it is ignored, so another user's exhausted host
   credential never blocks a person. Each balance carries the time it was
   read and is used for at most five minutes; a stale or unreadable
   balance, or a feed that has disconnected since publishing it, makes acts
   unsendable until a fresh read. The page also obeys the system's own
   rate-limit answer: a refusal holds every send until the reset it names.
   Partly met: see the exception below.
4. **Bound what one call can cost.** Every call has a deadline; each act is
   one write (one per decision for a card of several), and every list read
   has a page size and a declared ceiling. Met.
5. **Record what it cost.** The page counts the requests each act made and
   shows them with its result. Partly met: see the exception below.
6. **Fail as a closed class.** Each answer is mapped to the
   [failure classes](../../GLOSSARY.md): no answer is `unreachable` with a
   mark that the request was sent, a limit refusal is `rate-limited` with
   its reset, and the forge's 401, 404, 422 and 5xx are `unauthorized`,
   `not-found`, `invalid` and `server-fault`. The message ADR-0019 there
   gives for each status is kept and names its class. Met.
7. **Say what the reader does without an answer.** An act with no answer
   says it may or may not have been sent and reads the target again before
   offering to resend. A read shows its last result with its age. Nothing
   is retried automatically. Met.

**The exception to ADR-0021.** For calls the person's browser makes, and
for no other caller, these obligations are met as far as a browser can:

- obligation 1: a system the page acts on has two doors, the host's
  transport and the page's module, because the host accepts no request and
  so cannot carry the page's calls;
- obligation 3: admission is a read of the token's own balance, not a
  reservation in the budget record, so a person's act competes with the
  host's passes without holding a share;
- obligation 5: the host's cost ledger never receives the page's counts.
  The host's balance read shows the browser's spend only as unattributed,
  as it does for command-line calls whose answers it cannot read.

The reason is the record pull request #891 introduces: a host route that
took the page's calls would let any process running as the person press it.
The cost is bounded because each act is a person's click and a handful of
calls. The exception ends when a write route the person's acts may use
exists on the host or the [hub](../../GLOSSARY.md), which item 40 decides.

### What the unlock does not prove

The unlock shows the page that the person is at the device and protects a
lost or borrowed one. It tells the forge and the line nothing about who
sent an act, and it does not defend against a host that serves a tampered
page, which can read the token while it is unlocked. This record amends
the phone contract and the record pull request #891 introduces; it does not
amend the rule that a person merges
([ADR-0003](ADR-0003-a-person-merges.md)) or ADR-0013's rule against a
resident coordinator.

## Alternatives considered

- **The stored token of ADR-0019 there on every device, with no unlock.**
  Kept as the setting a person may choose; rejected as a phone's default,
  since a lost phone gives its finder the token.
- **A fingerprint prompt in front of a token kept in plain storage.** The
  prompt protects nothing a reader of the storage cannot skip; rejected.
- **A phone that stays read-only without the unlock.** It would take away
  the phone Send ADR-0019 there already gives; rejected.
- **A host write route behind a passkey.** ADR-0019 there rejects it, and
  it would let the host's own processes write; rejected.
- **Treating the unlock as proof to the line.** The forge sees only a token
  and cannot check the browser's local check; rejected.
- **Recording the page's costs on the host.** It needs a host route that
  accepts the page's requests; rejected for the reason above, which the
  exception records instead.

## Consequences

People act from a phone with the same confirmation as on a desktop, except
merging. A phone keeps its token encrypted by default. Browsers and
credentials differ, so the unlock needs a probe and a clear message where
it is unavailable. Losing the credential means a new token and a new
enrollment. A tampered page and the browser's memory remain risks. The
host's budget sees a person's acts late and unattributed, within the bound
above. No stronger proof of the author exists until item 40 lands.

## Extraction (decisions-become-checks)

Not mechanically checkable until the acts are built. No decision-rules
catalog exists in this repository. The implementation tests the refusal of
a merge on a phone, of any send over plain HTTP from a non-loopback
origin (and, separately, of any phone write over plain HTTP, which the
stricter phone rule forbids), of a request address built from a record's
URL or reached by a redirect, of a missing key-derivation result, of an
act below the budget floor and of one admitted on a stale balance or on
another login's balance; expiry after a
suspended tab resumes; a confirmation invalidated by a changed head; and
that no plaintext token is stored while the unlock is on. Review checks
that the page writes only through the existing request writers and its one
module per system, and that the host receives no act. The nested dashboard
instructions link this record when those parts are introduced.
