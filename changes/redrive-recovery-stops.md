---
release: minor
---

### Added

- `jig dispatch` [re-drives](../GLOSSARY.md) the stops whose next step is
  mechanical, rather than listing them for a person:
  - a drive that stopped `15` (a pass reached its deadline again after the
    driver spent its restarts) is re-armed once per head commit, on any
    admitted account. Its stop now records, as a stall's does, whether it
    left work in its tree; one that did is re-armed only in that tree, and
    the re-armed drive takes the edits as its own to finish;
  - a drive that stopped `1` while its pull request conflicts with its base
    is re-armed once per pair of its head and its base branch's head, so its
    conflict-resolve round runs;
  - a silent drive whose driver no launch started, armed by hand or by
    another tool in any clone, is taken over when the driver ran on this host
    and this host shows its run ended, on the evidence drive-pr's own
    recovery accepts (`drive-pr/scripts/driver-presence.ts`, read-only);
    `drive.ts --take-over` still decides. A driver on another host, or one
    whose run this host cannot show ended, is notified once. The takeover of
    a driver a launch started does not draw on the recovery budget;
  - a follow-up whose pass died during its work with no result and no
    question, within the last 6 hours, is run again once: the tick releases
    the marker it left, even one already answered failed, and a later tick
    starts it again. On the first tick after upgrading, a follow-up that died
    in the 6 hours before has its marker released and runs again; an older
    death stays a failed follow-up, notified, its marker kept. A
    follow-up a person asks for again by deleting a failed marker starts as a
    new one.

  A second stop at the same change (the same head, the same pair of heads,
  the same ledger facts, the same follow-up) is a person's, with the stop's
  handoff.
- One [recovery budget](../GLOSSARY.md) per pull request bounds these re-drives
  together with
  the re-arms of stops with no recorded cause: 3 in a rolling hour, across
  accounts and hosts. A launch that draws on it says so in its ledger facts
  (`recovery: `, beside the existing `no-cause: `); once it is spent, a person
  is told the re-drives repeated.
- `jig ask` says when a silent drive's driver is shown gone and a dispatcher
  may take it over, and reads a conflicting failure's base branch head as the
  dispatcher does.
