---
release: patch
---

### Fixed

- Reinstalling or upgrading a launchd job no longer alters a variable a
  person added to it when the installed plist is not UTF-8. Jig read the job
  as UTF-8 whatever its XML declaration said, so a non-ASCII value in an
  ISO-8859-1 plist was changed and written back. The install now refuses a
  job, and `jig upgrade` refuses to refresh one, that declares an encoding
  other than UTF-8 or whose bytes are not
  valid UTF-8, and says to convert it with `plutil -convert xml1` first.
