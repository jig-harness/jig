---
release: minor
---

Several hosts can now dispatch one repository: each host's launches and their ends travel on the pull request, where every other host reads them.

### Added

- **Several hosts can dispatch one repository.** A repository may be listed in the machine files of several hosts. Before a drive's launch the dispatcher posts a launch claim on the pull request beside its launch record, naming the record and the host, and writes the launch's end onto that claim at its next `--apply` run; the follow-up marker names its host too and carries the follow-up's answer (`outcome: done` or `failed`) once its launch ended. Every run reads every host's claims: a launch another host holds is reported as held by that host and never started twice, a follow-up another host ran reads as done or failed, and a driver another host started that fell silent past the lease window is taken over, as the drive ledger's own rule allows, never on a claim alone. A pickup's shared record is the tracker claim `do-item` already makes. The claims coordinate launches and never authorize an act a person takes; the forge cannot create a comment only if none exists, so the stage's own refusal (the drive's lock and ledger claim, `do-item`'s claim) stays the backstop ([plugin/README.md](../plugin/README.md#the-dispatcher), [plugin/RECORDS.md](../plugin/RECORDS.md)).
- **One owner host per repository.** A repository entry of the machine file takes `owner: true|false`, `true` by default. Only the owner notifies for the repository, writes its dispatch labels and writes outcome-log rows for what it did not launch, so each is written once. Every run's report names the host that owns the repository and says so when another host's claims say they own it too ([CONFIGURATION.md](../plugin/CONFIGURATION.md#the-machines-dispatch-file)).
- **`records.shared` in the machine file**, `forge`, the only value today: where a host publishes what another host reads. A value this version does not know is refused. Each run's receipt records every shared read and write and the forge budget left after them.

### Changed

- **A second host needs the same release and the `owner` field.** Install this release on every host that dispatches a repository, and set `owner: false` on every one of them but the owner. A single machine launches, notifies and records as before; what it shows on the forge besides is one claim comment per drive launch and the answer written onto each follow-up's marker.
