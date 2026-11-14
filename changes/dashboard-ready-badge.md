---
release: minor
---

The dispatch dashboard shows how many pull requests are ready to merge outside its own window.

### Added

- The dashboard puts the count its Merge tab carries in the browser tab's title (`(3) Dispatch`) and on its icon, and, in an installed app, on the app's icon where the browser has an app badge for it (desktop Chrome, and a dot or count on Android depending on the launcher). The count clears when nothing is ready. It updates only while the page is open: a closed app gets no badge, and a notice that reaches a closed app needs web push, which the dashboard does not ship.
