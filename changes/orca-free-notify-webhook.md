---
release: minor
---

### Added

- The dispatcher's `notify` stage works without Orca: a machine file can
  name notification channels under `notify.channels`, and a `webhook`
  channel posts each notification to an incoming webhook, an ntfy topic a
  phone subscribes to (`format: text`), a Slack channel (`slack`) or a
  Discord channel (`discord`). Each channel is sent once per cause, again
  after `dispatch.renotify_after`, and backs off in the failure ledger
  under `notice <channel> <key>` while its deliveries fail. The webhook's
  address is a credential: the machine file names the environment variable
  that holds it (`url_env`), and the address appears in no notification,
  receipt, log row or cost-ledger row
  ([CONFIGURATION.md](../plugin/CONFIGURATION.md#the-machines-dispatch-file)).
  A 429 holds the address in the host's budget record until its
  `Retry-After`, and every repository's notifications to it wait until
  then; a channel whose variable is unset is reported in each tick's
  receipt.
- A machine file with `runtime: process` now accepts `notify` among a
  repository's stages once it names a channel under `notify.channels`; the
  process runtime writes no Orca card. On `runtime: orca` a named channel is
  sent through beside the card, and with none named nothing changes.
