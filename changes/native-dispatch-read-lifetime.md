---
release: patch
---

### Fixed

- Native dispatcher queue preloading no longer lends its expired facet-read deadline to later issue reads in the same tick. Shared lazy reads keep the tick's deadline, while each caller retains its own cancellation and incomplete readings remain nonauthoritative.
