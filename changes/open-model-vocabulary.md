---
release: minor
---

Declare a model's tier with the new `routing.model_tiers` key, and choose a separate model for the steward with `routing.stages`.

### Added

- `routing.model_tiers` maps any model identifier that meets Jig's [token rules](../plugin/CONFIGURATION.md#the-open-model-vocabulary) (it holds no whitespace, commas, semicolons or equals signs, and is not the reserved key `__proto__`) to a [model tier](../GLOSSARY.md#model-tier) (`scout`, `execution`, `strategic` or `judgment`) with a reason, so `routing.models` can name a model the plugin's list of families does not.
- `routing.model_tiers` can be set in a host's user file, in a repository's `.config/jig.yaml` or per run; where both layer values are mappings, the merger combines their cells recursively, including a declaration's `tier` and `reason` fields. A higher-layer `routing: null` resets the whole routing section, while a surviving `routing.model_tiers: null` is refused; the configuration reference describes the remaining validation rules.
- `routing.stages.<stage>.models.<runtime>.<tier>` sets the model for one launch stage (`pickup`, `rearm`, `followup`, `steward`) in place of the all-stages cell of `routing.models`. A stage's cell is more specific than the all-stages one whichever layer set each. The dispatcher's steward launch reads its row; the other stages are accepted and checked.

### Changed

- For a runtime with a list of known families, a model that is neither a known family nor declared is still refused, and the message now names the key to set (`routing.model_tiers.<runtime>.<model>`) instead of `routing.family_tiers`.
- `routing.family_tiers` is kept as the older spelling of `routing.model_tiers`: a configuration that sets only it routes exactly as before. One model declared under both with different tiers is refused.
