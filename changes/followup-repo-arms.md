---
release: minor
---

### Added

- A repository adds its own arms to the [followup](../plugin/skills/followup/README.md) skill with `followup.arms` in `.config/jig.yaml`: for each, the change areas it applies to and what settles it, as an instructions file read from the integration branch (never the pull request's tree), a read-only check command that reads the merge facts and prints a verdict, or a skill from the repository, the user's home or another plugin. Repository arms are listed with the core arms, settled under the same rules (a run still cannot end while one has no verdict) and act only within the fixed authority table. A check command runs from a copy of the integration branch's files, only where `followup.authority.read-only-checks` leaves it to the follow-up, without the tracker and forge tokens, within 60 seconds (`JIG_FOLLOWUP_CHECK_TIMEOUT_SEC`) and 64 KiB of output, and one that runs past its limit, fails or prints no verdict is recorded unread, never not owed. The field is documented in [CONFIGURATION.md](../plugin/CONFIGURATION.md#followup), and the check command's contract in the [repository commands chapter](../plugin/protocol/repo-commands.md).
