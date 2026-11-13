---
release: patch
---

### Fixed

- A served Linear item whose assignment history names no user assignment (it holds no assignment of the person, or the assignment was made by an integration or an automation) is no longer read again on every dispatch tick. The answer is kept with the item's update time and reported with the same reason until the item changes; a failed or rate-limited history read is still read again on the next tick. **Consumer action:** none.
