---
release: minor
---

The dispatch dashboard shows which card the keyboard is on and what its keys do.

### Changed

- The card j and k rest on is tinted with an accent bar at its edge, in place of the browser's outline.
- A bar at the foot of the screen names the focused card and lists only the keys it answers to: o for its details, p for its pull request or i for its issue, c for its command (named, such as the merge command or the answer line), and j and k to move. It shows with a mouse or trackpad and stays away on touch screens.
- The whole reason of a History row is rendered as Markdown, as a decision already was, instead of one block of monospaced text; supported web and mail links open in another tab, while images stay inert.
