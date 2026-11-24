---
release: minor
---

Declare a model's tier with the new `routing.model_tiers` key. Choose a separate model for the steward with `routing.stages`.

### Added

- `routing.model_tiers` maps any model identifier that meets Jig's [token rules](../plugin/CONFIGURATION.md#the-open-model-vocabulary) (it holds no whitespace, commas, semicolons or equals signs, and is not the reserved key `__proto__`) to a [model tier](../GLOSSARY.md#model-tier) (`scout`, `execution`, `strategic` or `judgment`) with a reason, so `routing.models` can name a model the plugin's list of families does not.
- Routing declarations can be layered through a host user file, repository configuration or one run; mapping values merge recursively, including a declaration's `tier` and `reason`. A higher-layer `routing: null` resets the whole routing section. Validation refuses a surviving `routing.model_tiers: null`; a surviving `routing.family_tiers: null` is handled independently.
- `routing.stages.<stage>.models.<runtime>.<tier>` sets the model for one launch stage (`pickup`, `rearm`, `followup`, `steward`) in place of the all-stages cell of `routing.models`. A stage's cell is more specific than the all-stages one whichever layer set each. Implementer routing reads the active runtime's all-stages cell; the dispatcher's steward launch reads its `steward` row. The other stage rows are accepted and checked.

### Changed

- For a runtime with a list of known families, an unrecognized model identifier that neither declaration key classifies is refused. The message names the key to set (`routing.model_tiers.<runtime>.<model>`) instead of `routing.family_tiers`.
- `routing.family_tiers` is kept as the older spelling of `routing.model_tiers`: a configuration that sets only it routes exactly as before. One model declared under both with different tiers is refused.
- A declared exact model identifier is validated when its selected launch is built. The shared routing table remains usable by every supported CLI launch that accepts the configured identifier; an Agent-tool delegation keeps that tool's alias restriction at its own boundary.
