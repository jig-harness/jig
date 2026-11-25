---
release: minor
---

Declare a model's tier with the new `routing.model_tiers` key. Choose a separate model for the steward with `routing.stages`.

### Added

- `routing.model_tiers` maps any model identifier that meets Jig's [token rules](../plugin/CONFIGURATION.md#the-open-model-vocabulary) to a [model tier](../GLOSSARY.md#model-tier) (`scout`, `execution`, `strategic` or `judgment`) with a reason, so `routing.models` can name a model the plugin's list of families does not.
- Routing declarations can be layered through a host user file, repository configuration or one run; mapping values merge recursively, including a declaration's `tier` and `reason`. A higher-layer `routing: null` resets the whole routing section. The effective runtime loader refuses a `null` only when it survives the merge at the exact path: `routing.model_tiers: null` is refused, while `routing.family_tiers: null` remains an empty compatibility table. The audit separately checks the repository file's refused-null paths.
- `routing.stages.<stage>.models.<runtime>.<tier>` sets the model for one launch stage (`pickup`, `rearm`, `followup`, `steward`) in place of the all-stages cell of `routing.models`. A stage's cell is more specific than the all-stages one whichever layer set each. Every configured row is validated when routing loads; implementer routing reads the active runtime's all-stages cell, and the dispatcher's steward launch currently reads its `steward` row.

### Changed

- For a runtime with a list of known families, an unrecognized model identifier that neither declaration key classifies is refused. The message names the key to set (`routing.model_tiers.<runtime>.<model>`) instead of `routing.family_tiers`.
- `routing.family_tiers` is kept as the older spelling of `routing.model_tiers`: a configuration that sets only it routes exactly as before. One model declared under both with different tiers is refused.
- Jig validates token shape, family classification and tier ordering for a declared exact model identifier; the selected runtime validates whether its provider accepts that identifier. The shared routing table remains usable by every supported CLI launch that accepts the configured identifier; an Agent-tool delegation keeps that tool's alias restriction at its own boundary.
- Declared routing identifiers and reasons get two separate treatments in audit output. Both reports format a value for display: one that holds a control character, a bidirectional control or a newline is JSON-quoted, so its quotes and backslashes are escaped too, and a finding's message carries that formatted text, an identifier included. A reason is trimmed before it is formatted, so a trailing newline alone does not trigger the quoting; an identifier outside the bare-key grammar is JSON-quoted as well, so a backslash in it is escaped. The Markdown report additionally renders the text literally, so a reason such as `**local policy**` shows as written (bare links, email addresses and mentions are put in code spans; emoji shortcodes such as `:warning:` are not protected); the structured (JSON) report keeps the already-formatted message as it is, without Markdown escaping.
