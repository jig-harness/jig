---
release: minor
---

### Added

- The dispatch dashboard's Needs you cards can send a parked decision's answer: with a fine-grained GitHub token pasted under **Send from here**, a parked drive's card on github.com has **Send** beside Copy, which posts the comment Copy takes to the pull request from the browser, as the person, then links the comment and says it was sent here. A guarded pick sends on the second step, GitHub's refusals are explained, and a card no drive reads an answer comment for says why it has no Send. The token is tested against GitHub, kept in that browser alone and never reaches the host, whose server still has no route that writes ([ADR-0017](../docs/adr/ADR-0017-the-dashboard-page-answers-as-the-person.md), [plugin README](../plugin/README.md#the-dispatcher)).

### Security

- The dashboard page's content security policy lets the page connect to its own server and `https://api.github.com` alone; a page that runs no script connects to its server alone.
