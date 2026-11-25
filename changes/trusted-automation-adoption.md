---
release: patch
---

### Security

- Set `dispatch.adopt.trusted_automation: false` to review install inputs
  before starting or rearming a listed bot's drive by hand. This applies even if
  the bot is named in `dispatch.adopt.authors`. The
  [trusted automation configuration guide](../plugin/CONFIGURATION.md#trusted-automation)
  describes which inputs to review and how to handle existing drives.
