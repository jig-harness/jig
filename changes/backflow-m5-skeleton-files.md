---
release: minor
---

M5 names the split between skeleton files, which hold the architecture's contracts and which agents treat as read-only, and tissue, which agents may change freely, and ships the gate that enforces it.

### Added

- M5 ADR practice: a skeleton-file inventory template (`templates/skeleton.yaml`) and a reference gate (`reference/skeleton-gate/check-skeleton-adr.ts`, with fixtures built in its self-test). A change to a listed file merges only when it edits the inventory or a `Decision-Record: ADR-NNNN` trailer names a record that resolves to one file and has an approved or amended status that nothing superseded. The gate runs as a `commit-msg` hook and, over a pull request's range, as the CI authority; it fails closed on an inventory entry that matches no file (a renamed or deleted skeleton file), on a skeleton file renamed out of a listed directory, and on input it cannot read. It extends M1's commit-msg marker, and M5's mappings give the hook, CI and code-owner wiring per host.
- The M0 AGENTS template gains a "read before modifying" line for the skeleton inventory.
- Audit: the M5 criterion `skeleton-changes-need-recorded-authority` (Strict, mechanical), scored in Jig's own record and the calibration record. The glossary gains "Skeleton file / tissue".
