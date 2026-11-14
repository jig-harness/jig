---
release: patch
---

### Fixed

- A steward `resume` record the tick can never apply (its pass framed a
  decision for a person, recommended no single option, ended done, or was
  already resumed) is now refused once, with its reason reported, instead of
  staying unapplied while the steward proposed it again on every run. The
  steward's digest no longer offers a pass that framed a decision, or one
  whose resume was already launched or refused.
- The tick no longer resumes a dispatched pass that recorded a framed
  decision for a person: that decision is the person's to answer.
