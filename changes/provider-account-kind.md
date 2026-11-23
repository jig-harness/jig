---
release: minor
---

### Added

- The dispatcher's machine file accepts a provider account (`kind: provider`), which bills a model provider with the host's own key: a harness (`claude-code` or `codex`), a provider, an optional base URL, a credential reference such as `op://Vault/item/field` (a key written in its place is refused when the file loads) and, for a `pay-per-token` key, a required daily spend cap with an optional per-run ceiling; a `flat-rate` plan takes no cap. The host's `credential_command` resolves the reference at each launch, a refusal holds the account with one need for a person, and the pass's environment carries that account's key and no other provider's. A provider account's identity is derived from its reference and base URL, so it needs no login email. Nothing is launched on a provider account until the spend-cap work merges: dispatch reports it as configured and not admitted. See [provider accounts](../plugin/CONFIGURATION.md#provider-accounts).
- A repository names the model providers its code may be sent to in `dispatch.allowed_providers`, read from its default branch. The dispatcher refuses a launch on an account whose provider the list lacks, as `provider-not-allowed` naming the repository, the account and the provider. A repository with no list keeps using its Claude and OpenAI subscription accounts, so nothing changes for a host with only subscription accounts. See [`dispatch`](../plugin/CONFIGURATION.md#dispatch).

### Security

- A subscription account's pass environment removes `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and each vendor's directory variable whatever their letter case, so a mixed-case name such as `Anthropic_Api_Key` no longer reaches it on a platform whose names ignore case.
- A dispatched pass's environment no longer carries `JIG_PROVIDER_CREDENTIAL`, `JIG_PROVIDER_IDENTITY` or `JIG_SECRET_VARIABLES` from the environment it starts from; a provider account's pass gets the last two from its own launch. Nor does it carry a variable the machine file's `credential_env` names for the credential command.
