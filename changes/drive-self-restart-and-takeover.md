---
release: minor
---

A drive recovers by itself from the stops that need no decision, and a stopped or stuck drive can be picked up from another session of the clone.

### Added

- `drive-pr` restarts from a pass killed at its deadline: it reports what the pass left uncommitted and unpushed, leaves both in the tree, tells the next pass what it inherits and starts the next round, up to `drive.pass_deadline_retries` times per drive (default 2, [configuration](../plugin/CONFIGURATION.md#drive)); past that it stops with exit `15` and says the budget is spent. See [a stopped drive restarts itself](../plugin/skills/drive-pr/README.md#a-stopped-drive-restarts-itself).
- A stalled drive runs one more round with the stall's diagnostics in the pass's notice before it stops with exit `14`, and the stop prints what the passes recorded deciding at the end of the handoff narrative.
- A quota park records the billing account the wall belongs to (hashed), and the exit names it and prints the re-arm command. While the wall is in effect, a re-arm is admitted from a pass that bills a different account and refused with exit `16` on the same account or an unknown one; `--window-reopened` lets a person re-arm once a window whose reset was never known has reopened. See [picking up a stopped drive](../plugin/skills/drive-pr/README.md#picking-up-a-stopped-drive).
- A park records when it was made, and a re-arm of a drive stopped `HITL_PARKED` unparks every item once each has an answer from an owner, member or collaborator later than the park (on its thread, or in a pull-request comment naming its key), and hands the answers to the first round as human verdicts.
- `drive.ts <PR> --take-over` replaces a driver that holds the drive's locks when `drives.ts --doctor` calls it `WEDGED`, stopping it with the identity check `--stop` makes, or when its process is gone and its tree holds nothing unpushed; it records the takeover in the drive state, reconciles replied threads before the first triage, resumes at the same round, and reopens a held thread whose promised fix never landed with a reply that says so. Against any other holder it refuses with exit `11`.

### Changed

- An exit-`11` refusal names the holder's `--doctor` verdict and, when the holder is `WEDGED`, prints the `--take-over` command. The rule for a live driver is now "do not stop a driver that is making progress; take over one that is wedged or dead", in `drive-pr` and `do-item` alike.
