---
release: patch
---

### Fixed

- A host's weights file (`weights.local.yaml`) that names an account the
  machine file does not list no longer closes every account for new
  launches. The name is skipped and the file's other weights apply; each
  account's reason in the receipt and the account view names what was
  skipped, and the host raises one notice naming the file, the skipped
  names and the accounts the machine file lists. Every other fault in the
  file still closes every account.
