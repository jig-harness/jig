---
release: minor
---

### Added

- One module for every claim Jig makes on a pull request:
  `plugin/shared/records/forge-claims.ts` posts a
  [forge claim](../GLOSSARY.md), reads it back, decides it, re-checks it
  before an act and withdraws it. The takeover claim, the follow-up marker
  and the merge-ready announcement are its kinds, under one rule: of
  the trusted claims on one key the earliest comment wins, with the lease
  window as the takeover's lapse window. Who is trusted is one rule too:
  the reading script's own login, or an owner, member or collaborator.

### Changed

- A claim's read-back that does not list the comment just posted now reads
  again up to three times, two seconds apart, and then treats the claim as lost
  instead of counting a comment it never saw. A takeover whose claim is
  never listed refuses the drive with exit `1`, as one whose read-back
  fails; a re-arm from the same clone drives by that claim once the
  comments read. `jig dispatch marker claim` keeps its exit codes.
- The merge-ready announcement is a claim per pull request and head: it is
  posted only while its merge-readiness checks hold, of two announcements of
  one head the earlier stands and the later driver withdraws its own, and
  an announcement whose read-back never lists it is withdrawn and the
  script exits `1`. Its record now sits in a hidden block after the first
  line; it still ends with the head marker, so an earlier version still
  reads it, and an announcement written by an earlier version still reads.
  A trusted announcement whose record and head marker name different heads
  stays visible: the script refuses to announce over it and to withdraw
  around it, and asks for it to be removed by hand.
- The takeover claim carries the record envelope. An earlier version still
  reads the new claim, and a claim written by an earlier version still
  reads.
- The follow-up marker's record moves to version 2, which names the claim
  `followup` and the pull request beside the run. A marker written by an
  earlier version still reads. An earlier version reads the new form as a
  marker it cannot read, so it plans no follow-up for that pull request and
  reports it: update every machine that dispatches a repository, and every
  machine a follow-up is run from by hand, together.
- When a merged pull request carries two trusted follow-up markers, the
  dispatcher's report names the earlier one, which holds the follow-up for
  the marker commands.
