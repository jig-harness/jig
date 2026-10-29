---
release: minor
---

A pull request's drive resumes from the pull request itself: a drive started in another clone or on another machine picks up where the last one stopped, and a stuck driver in another clone can be taken over.

### Added

- `drive-pr` mirrors the resumable part of its state into one comment on the pull request, the drive ledger (`<!-- drive-pr-ledger -->`): its version and generation, the round and phase, the last counted and verified heads, the Ready mark, every parked item with its decision, every held item with its outcome and pushed commit, the takeovers, the driver's working tree, hashed account and heartbeat, and the last twenty lines of the handoff narrative. The driver writes it at every round boundary, park and takeover, and when it stops. A ledger too long for one comment loses the held items' outcomes first and the narrative second, never a parked decision. Only a ledger written by the drive's own login or by an owner, member or collaborator is trusted; any other comment carrying the marker is ignored and reported. See [where its state lives](../plugin/skills/drive-pr/README.md#where-its-state-lives).
- A drive that starts with no state for the pull request, or with state older than the ledger's generation, seeds its state from the ledger; a ledger version it does not read stops it with exit `1`, naming the version. `DRIVE_PR_LEDGER=off` drives without the ledger.
- `drive.ts --take-over` reaches a driver in another clone: it is admitted once that driver's ledger heartbeat is older than the lease window (the doctor's stall threshold), and claimed with a takeover claim on the pull request (`<!-- drive-pr-takeover-claim -->`). Of two clones claiming at once the earlier comment wins. See [picking up a stopped drive](../plugin/skills/drive-pr/README.md#picking-up-a-stopped-drive).
- A new terminal state, `TAKEN_OVER` (exit `20`): a driver that finds another clone's takeover claim newer than its own at a round boundary stops without another pass, and a claimant whose claim lost to an earlier one stands down. The arbitration holds once every driver of a pull request runs a version that reads the ledger.

### Changed

- Arming a drive while the ledger names a running driver in another clone is refused with exit `13`, naming that driver's heartbeat and, once it is past the lease window, printing the `--take-over` command. Before, a second clone could drive the same pull request beside the first.
