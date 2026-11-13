---
release: patch
---

### Fixed

- Test scratch can be collected after a killed runner when persistent fixture registrations prove its holders gone. Registrations survive removal and recreation of the scratch root, but a replacement legacy owner cannot claim an earlier registration. Unknown native child trees, incomplete launches and legacy scratch remain retained with their reasons. Declare the test directory prefix and refresh the collector's confirmed bounds to include it before collection.
