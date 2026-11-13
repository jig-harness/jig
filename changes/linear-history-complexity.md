---
release: patch
---

Reading who made a Linear assignment costs a tenth of the query complexity it did.

### Fixed

- The assignment-history and state-history reads asked Linear for each history entry's user together with the user's teams, with no limit on the team list. Linear prices an unlimited list at its default page of 50 for every one of up to 100 history entries, so one history read cost about 6,000 points of the credential's hourly complexity limit (3,000,000), where the same read with the list limited to the one team it is filtered to costs about 600, with the same answer. A served queue that re-reads a dozen assignment histories every tick therefore spent most of the complexity Linear refills in the tick interval, and the dispatcher's reads were held back at the `tracker_share` floor.
