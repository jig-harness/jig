---
release: minor
---

Declare a model's tier with the new `routing.model_tiers` key, and choose a separate model for the steward with `routing.stages`.

### Added

- `routing.model_tiers` maps any model identifier that meets Jig's [token rules](../plugin/CONFIGURATION.md#the-open-model-vocabulary) (it holds no whitespace, commas, semicolons or equals signs, and is not the reserved key `__proto__`, which the shared loader rejects as a declaration key) to an M0 tier with a reason, so `routing.models` can name a model the plugin's list of families does not. Set it in a host's user file, in a repository's `.config/jig.yaml`, or per run; the runtime loader merges these mappings cell by cell across the layers. A `null` in a higher layer replaces the lower table whole, and routing validation refuses it if it survives in the merged runtime configuration; the reference says which layers can replace it and how, and which declarations a selected model still needs ([the open model vocabulary](../plugin/CONFIGURATION.md#the-open-model-vocabulary)).
- `routing.stages.<stage>.models.<runtime>.<tier>` sets the model for one launch stage (`pickup`, `rearm`, `followup`, `steward`) in place of the all-stages cell of `routing.models`. A stage's cell is more specific than the all-stages one whichever layer set each. The dispatcher's steward launch reads its row; the other stages are accepted and checked. See [the open model vocabulary](../plugin/CONFIGURATION.md#the-open-model-vocabulary).

### Changed

- For a runtime with a list of known families, a model that is neither a known family nor declared is still refused, and the message now names the key to set (`routing.model_tiers.<runtime>.<model>`) instead of `routing.family_tiers`.
- `routing.family_tiers` is kept as the older spelling of `routing.model_tiers`: a configuration that sets only it routes exactly as before. One model declared under both with different tiers is refused.
