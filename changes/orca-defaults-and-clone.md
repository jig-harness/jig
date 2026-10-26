### Added

- The workspace launcher's configuration takes `defaults`: the settings every
  repository label starts from, `{label}` read as the label, so a machine
  that opens every repository the same way (one Orca server, say) needs an
  entry only for a label that differs from its repository
  ([tools/launcher](../tools/launcher/README.md#configuration)).
- The Orca workspace tool clones a repository Orca does not have yet, adds
  it to Orca and opens it, once however many launches reach it at the same
  time, when given `--clone-url` and `--clone-root`; the launcher's Orca
  setting `clone: {url, root}` passes them
  ([tools/orca](../tools/orca/README.md#a-repository-orca-does-not-have)).
