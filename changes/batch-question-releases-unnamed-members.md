---
release: patch
---

### Fixed

- **Dispatch:** a batch pickup that ended on a question no longer holds every
  member the question does not name. The members it never claimed and the
  question does not name are picked up again by the queue's usual rules, with
  no need raised for them, whether or not the pass claimed any member; hosts
  holding members this way release them on the first tick after the upgrade.
  A question that names no member is one need on the batch's anchor, the other
  members wait on it with no need of their own. When an open pull request
  carries the anchor, answering it settles the batch without releasing that
  carried claim; an unreadable pull-request link refuses the release.
- **Dispatch:** a batch whose pass stopped on a fault of its host keeps its
  members held while the host's health check fails, even when the stop's text
  names a member, and a legacy record that cannot say which member it claimed
  stays conservative after one claim is observed. A claimed member of a batch
  with a whole-batch question waits on the anchor's need with no need of its
  own, and an anchor carried by an open pull request stays quiet as any
  carried item does.
