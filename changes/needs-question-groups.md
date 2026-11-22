---
release: minor
---

### Added

- The dispatch dashboard's Needs you shows needs whose decisions are identical apart from their own target as one card: the question once, how many targets it covers, and each target with its repository, link, age and its own evidence. One pick on the card answers every target listed, and Send posts each target's own answer, as you, so every station still checks it; leave out the targets you mean to settle differently, and they stay open. A target whose answer the tick refused, or whose facts changed, becomes its own card again. See [design/need-classes.md](../design/need-classes.md#identical-questions-fold). **Consumer action:** none.
- `jig ask --waiting --json` names each entry's `questionGroup`, the identity the dashboard's card carries, so another reader of Needs you's rules can show the same groups. **Consumer action:** none.
