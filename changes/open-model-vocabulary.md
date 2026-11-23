---
release: minor
---

A model outside the known families can now be routed by configuration alone.

### Added

- `routing.model_tiers` maps any model identifier to an M0 tier with a reason, so `routing.models` can name a model the plugin's list of families does not. Set it in a host's user file, in a repository's `.config/jig.yaml`, or per run; the layers merge cell by cell as for every other section.
- `routing.stages.<stage>.models.<runtime>.<tier>` sets the model for one launch stage (`pickup`, `rearm`, `followup`, `steward`) in place of the all-stages cell of `routing.models`. A stage's cell is more specific than the all-stages one whichever layer set each. The dispatcher's steward launch reads its row; the other stages are accepted and checked. See [the open model vocabulary](../plugin/CONFIGURATION.md#the-open-model-vocabulary).

### Changed

- A model that is neither a known family nor declared is still refused, and the message now names the key to set (`routing.model_tiers.<runtime>.<model>`) instead of `routing.family_tiers`.
- `routing.family_tiers` is kept as the older spelling of `routing.model_tiers`: a configuration that sets only it routes exactly as before. One model declared under both with different tiers is refused.
