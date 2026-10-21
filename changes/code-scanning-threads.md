---
release: minor
---

### Added

- `resolve-review-comments` works the review threads GitHub opens for code
  scanning alerts, from CodeQL, SonarQube Cloud or any other tool that reports
  to GitHub code scanning. The thread listing attaches each thread's alert,
  whose severity and security category feed the decline ladder, and the new
  `dismiss-alert.ts` dismisses the alert when the finding is rejected,
  declined or deferred, so a resolved thread no longer leaves an open alert
  failing the tool's check
  ([code scanning alerts](../plugin/skills/resolve-review-comments/README.md#code-scanning-alerts)).
