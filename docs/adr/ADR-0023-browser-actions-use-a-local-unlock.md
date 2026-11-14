---
title: "ADR-0023: Browser actions use the person's credential and a local unlock"
type: adr
status: draft
description: "The overview may offer phone actions except merge through the person's browser, with confirmation and an optional WebAuthn PRF unlock that protects stored tokens without claiming proof to the line"
lifecycle: permanent
version: "1.0"
last_updated: 2026-11-14
owner: maintainers
decision_date: 2026-11-14
supersedes: ~
superseded_by: ~
tags: [adr, dashboard, security, phone]
---

# ADR-0023: Browser actions use the person's credential and a local unlock

**Status:** Draft · **Date:** 2026-11-14 · **Deciders:** Jig's maintainers through pull-request review

## Context

The dashboard's phone contract requires a separate phone design and proof of
presence before writes. The [overview design](../../design/priorities-and-overview.md)
supplies that design. A person should answer and authorize work from a phone
without a route into a host, while keeping the rule that a person merges.
A browser may authenticate local presence without telling the forge or the
line anything about who posted a request. Credential-dependent support and
host-served page integrity limit what a browser unlock can promise.

## Decision

The overview's phone view may offer every desktop act except merge, in the
build order in the overview design. Each act is one write the line already
reads, made directly from the browser as the person with their credential,
and confirmed with the exact payload and target. No host receives a request.
The File draft and steward approval are the named new record kinds. No act
marks an outside-code step done; a follow-up checks its closing condition or
reads the person's answer before transitioning it.

The optional local unlock defaults on for phones and off for desktops, with
a configurable session lasting 30 minutes by default. WebAuthn's PRF
extension protects an encrypted token at rest; a boolean presence check alone
cannot unlock persistent plaintext. An actual PRF create/get/decrypt probe
is required before enrollment. The unlocked token remains only in page
memory until fixed expiry, explicit lock or page close. Phone actions require
the private-network HTTPS front; HTTP and unsupported phone credentials stay
read-only. Turning unlock off on a phone also leaves it read-only and
removes its stored token. A desktop with unlock off uses explicit
session-only token entry without persistent storage. Current iOS and Android
source evidence and the required physical
device probes are recorded in the overview design, before action code ships.

The unlock protects a lost or borrowed device. It proves no author to the
forge or line and cannot defend against a host serving a tampered page.
Until the pass trust boundary lands, actions have exactly the trust of
`jig send` from the person's terminal, and attested classes retain their
existing requirements. This amends the phone contract, not the rule that a
person merges or ADR-0013's rule against a resident coordinator.

## Alternatives considered

- **Read-only phone forever.** Retains today's boundary but leaves ordinary
  answers dependent on another device; retained as the unsupported fallback.
- **A biometric prompt followed by a persisted token.** Gives no encryption
  boundary when the token can be read without the credential; rejected.
- **A host write endpoint.** Adds inbound authority the existing browser
  path avoids; rejected.
- **Treat unlock as attestation to the line.** The forge sees a token and
  cannot verify the local ceremony; rejected.

## Consequences

People can answer on phones with the same confirmations as on desktop,
while merge stays desktop-only. Browser and credential variation adds an
explicit probe and a read-only fallback. Losing the credential requires new
token enrollment. A tampered page and compromised browser memory remain
risks; this design cannot claim stronger author trust until that separate
boundary is enforced.

## Extraction (decisions-become-checks)

Not mechanically checkable until the actions are implemented. No decision-rules
catalog exists in this repository. Implementation must test refusal of phone
merge, HTTP writes and missing PRF results, fixed expiry after suspension,
changed-head confirmation, and the absence of persistent plaintext tokens.
Review checks that the browser calls only the existing request writers and
that the host receives no action request. The nested dashboard instructions
must link this record when those components are introduced.
