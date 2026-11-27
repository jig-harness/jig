---
release: patch
---

### Fixed

- **Steward:** an `order` record the queue cannot take is now refused with its
  reason instead of being kept unapplied and unexplained. The tick refuses one
  whose targets are not all wanted, or do not tie on every ranking key (the
  exact creation time included), keeps why on the record, and lists the
  refusal in the steward's next digest under `refused` while the targets read
  as they did; an order naming the same targets is then not kept again. The
  steward skill now says what a tie is. The dispatcher's state database gains
  one column for the refusal. **Consumer action:** none.
