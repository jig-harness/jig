### Fixed

- Renovate no longer reads the pinned, drifted and malformed versions inside `fixtures/` folders as Jig's own dependencies, so the Dependency Dashboard stops offering updates that would break the gates' test inputs and no longer reports a failed lookup for a fixture workflow.
