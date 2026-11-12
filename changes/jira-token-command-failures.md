---
release: patch
---

### Fixed

- Jira token commands that exceed the request deadline report an unavailable broker with the variable name. Once Jira refuses a replacement token, the process stops renewing the command on later requests.
