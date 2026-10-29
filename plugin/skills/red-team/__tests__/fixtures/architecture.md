---
title: "Shared lists — architecture"
type: architecture
status: draft
created: 2026-10-02
updated: 2026-10-02
---

# Architecture: Shared lists

## Architecture overview

Phones talk to one list service, which keeps lists in one database and
pushes every change to every member's phone over a long-lived connection.

- **Principles:** one source of truth per list; the server decides the order
  of changes.

## Key decisions

| Decision | Choice | ADR |
|----------|--------|-----|
| Change delivery | a long-lived connection per phone | ADR-0001 |

## Components

### List service

- **Responsibility:** stores lists and items, and sends changes to members.
- **Interfaces:** an HTTP interface for reads and writes, a socket for
  changes.
- **Satisfies:** FR-1, FR-2, NFR-1

## Data model

- **list:** id, name, owner — has many items and members — kept forever.
- **item:** id, list id, text, bought — deleted with its list.

## Interfaces and contracts

- **Invite:** list id and an email address → an invitation link that never
  expires.

## Security and privacy

- **AuthZ:** anyone with the invitation link joins the list.
- **Data handled:** email addresses of invited people.

## Scale and cost

| Horizon | Load | What changes | Rough cost |
|---------|------|--------------|-----------|
| Launch | 1,000 households | — | small |

## Risks and open questions

- **Risk:** connections drop on mobile networks — **mitigation / spike:**
  none yet.

## Traceability

| Requirement | Met by |
|-------------|--------|
| FR-1 | List service |
| FR-2 | List service |
