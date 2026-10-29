---
release: patch
---

### Changed

- The values a repository already implies for its configuration (the gate
  command, review bots, the repository the forge names, stacked pull
  requests, the issue-tracker team, the change-area catalog, the integration
  branch and the package manager) are read by one detector the skills share,
  `plugin/shared/detect.ts`, which returns each value with the evidence it
  was read from and drafts the starter configuration. The audit's
  configuration fit and `fix-ci`'s package-manager detection call it; what
  they report is unchanged.
