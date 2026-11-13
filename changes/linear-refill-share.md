---
release: patch
---

The dispatcher no longer waits an hour for Linear after spending its share of the rate limit.

### Fixed

- Linear's request and complexity limits refill continuously, but the machine's request budget treated the dispatcher's share as spent until the reset Linear names, which is always an hour after the last answer. A tick that took the window down to its share floor (`tracker_share`, 50% by default), such as a cold read of a large queue, therefore stopped every tracker read of the dispatcher for an hour, though the refill brings the window back above the floor in seconds when it was only just below it. The budget now counts the refill of each window since it was last read, never past the window's limit, and the tick's reads resume as soon as the window is back above the floor, however long that takes for a larger deficit. A window that resets whole keeps waiting for its reset.
