---
release: patch
---

### Fixed

- `resolve-conflicts` classifies the conflicted paths from what the commit will carry, not from the working tree: `conflict-map.ts` and `check-resolution.ts` read `.config/jig.yaml` (or the file `JIG_OVERLAY` names inside the repository) and the change-area catalog from the git index (following the symbolic links the index holds, with `/` the only path separator) and the attributes with `git check-attr --cached`. A filename that holds a literal backslash, a link retargeted only on disk, and an untracked or ignored `.gitattributes` file no longer let a resolution pass that the committed catalog or attributes would reject. A change to the configuration or the catalog takes effect once it is staged. `check-resolution.ts` no longer reports a declaration whose working tree differs from the index, since the working tree decides nothing; the conflict-marker scan of staged changes reads the index's `.gitattributes` files as well (`git --attr-source`, Git 2.40, already required).
