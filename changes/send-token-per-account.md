---
release: minor
---

### Added

- The dispatch dashboard's Send keeps one GitHub token per account in the browser, each naming the repository owners it answers for, and a card sends with the token for its target repository's owner, so answers on repositories reached as different accounts post as the right login. A token that names no owner answers for every owner no other token names, and a browser that kept one token keeps it that way. A card whose owner no token answers for has no Send and says so; Copy still works. The settings panel tests, shows and forgets each token on its own, and refuses a second token for one owner. The confirmation and the card's "Sent here" name the login that answered. Forgetting or replacing a token asks again for confirmation only on the cards it answered. The tokens still never reach the dashboard's server ([ADR-0019](../docs/adr/ADR-0019-the-dashboard-page-answers-as-the-person.md#which-token-a-card-sends-with)).
