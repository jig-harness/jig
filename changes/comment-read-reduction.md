---
release: patch
---

### Changed

- The dispatcher groups comment reads for pull requests with outstanding launch
  claims outside the open and merged listings. When the grouped answer is
  incomplete, the dispatcher reads the affected pull request's comments on
  their own. It still checks the forge before it writes a claim or launches work.
