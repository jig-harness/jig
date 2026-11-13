---
release: patch
---

The dispatcher reads a repository's pull requests in pages as large as the forge answers in time.

### Fixed

- A repository whose open pull requests each carry many check results could not be read at all. GitHub ends a query it has worked on for about ten seconds (HTTP 502 or 504); the dispatcher asked for fifty pull requests a page, and its fallback listing asked for every pull request's checks at once. Such a repository's turn failed on every tick, so it got no re-arm, follow-up or pickup. A page the forge runs out of time on is now asked again at half the size, down to one pull request, and the size that read is kept for the repository, so later ticks start from it. The kept size is tried larger again once pages answer quickly and an hour has passed since it last shrank. The comments query over merged pull requests shrinks the same way. The fallback listing is asked once more without the checks, which then read as unknown. The forge record says the page size where it is under fifty, and names both failures when neither read answers.
