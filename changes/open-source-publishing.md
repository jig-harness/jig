---
release: minor
---

Jig prepares to publish: the documents a public project needs, the
address of the `jig-harness` organization the repository moves to, and CI
on the runners a public repository gets.

### Added

- [GOVERNANCE.md](../GOVERNANCE.md): one maintainer decides, what stays with
  a person, how a contribution gets in, and that the licence will not
  change. [SECURITY.md](../SECURITY.md): how to report a vulnerability
  privately, and what the skills run with your credentials.
  [TRADEMARK.md](../TRADEMARK.md): what anyone may do with the name and the
  logo. [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md). Issue and pull request
  templates.
- [ADR-0006](../docs/adr/ADR-0006-home-copyright-and-brand-held-apart.md):
  the repository's home, the copyright holder, the holder of the name, and
  what happens to each if its holder can no longer carry it.
- [CONTRIBUTING.md § Outside contributions](../CONTRIBUTING.md#outside-contributions)
  says which contributions are welcome as a pull request, which need an
  issue first, which are not taken, and how a fork's pull request is run
  and reviewed.

### Changed

- The project's full name is Jig Harness; the documents say Jig for short.
  The plugin's name and id do not change.
- **Breaking:** every address in the documents, the manifests and the
  install commands is `https://github.com/jig-harness/jig`. Once the
  repository is there, re-add the marketplace at the new address
  ([plugin/README.md § Install](../plugin/README.md#install-the-plugin));
  the plugin's name and id (`jig@jig`) do not change, and installing no
  longer needs a GitHub login.
- NOTICE names the licensor, and the origin-reference gate reads the
  licensor's name from NOTICE and allows it only where the pattern file
  says.
- CI runs on GitHub-hosted runners, which a public repository gets without
  charge; the nightly macOS and Windows runs use the standard images.
- [ADR-0003](../docs/adr/ADR-0003-a-person-merges.md) is amended: a person
  merging is also the supply-chain control of a public `main`.
