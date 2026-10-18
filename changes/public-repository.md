### Changed

- The [queue-watchdog](../modules/M13-pipeline-economy/templates/queue-watchdog.yml)
  and [runtime-canary](../modules/M14-testing-strategy/templates/runtime-canary.yml)
  workflow templates check out Jig without a token of their own: Jig's
  repository is public, so the checkout needs no credential. A workflow
  copied from an earlier template can drop the Jig checkout's `token` line
  and the secret it names.
