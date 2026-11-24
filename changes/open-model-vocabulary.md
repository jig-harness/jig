---
release: minor
---

A model outside the known families can now be routed by configuration alone.

### Added

- `routing.model_tiers` maps any model identifier that meets Jig's [token rules](../plugin/CONFIGURATION.md#the-open-model-vocabulary) (it holds no whitespace, commas, semicolons or equals signs, and is not the reserved key `__proto__`, which the shared loader rejects as a declaration key) to an M0 tier with a reason, so `routing.models` can name a model the plugin's list of families does not. Set it in a host's user file, in a repository's `.config/jig.yaml`, or per run; mappings merge cell by cell as for every other section, and a higher layer's non-mapping value (such as `null`) replaces the lower mapping whole in the merge, and routing refuses a `null` that survives every layer for `routing.model_tiers`. A `null` in a repository's file erases the host's `routing.model_tiers` table (not `routing.family_tiers`); a later environment mapping replaces that `null` without restoring the host's table, which clears the refusal, and the merged routes must still validate, so a model the host selected is refused when it lies outside the catalog of a runtime that has one and no surviving declaration (in the environment or in `family_tiers`) names it; a repository that also selects a cataloged model in the same layer raises no refusal.
- `routing.stages.<stage>.models.<runtime>.<tier>` sets the model for one launch stage (`pickup`, `rearm`, `followup`, `steward`) in place of the all-stages cell of `routing.models`. A stage's cell is more specific than the all-stages one whichever layer set each. The dispatcher's steward launch reads its row; the other stages are accepted and checked. See [the open model vocabulary](../plugin/CONFIGURATION.md#the-open-model-vocabulary).

### Changed

- For a runtime with a list of known families, a model that is neither a known family nor declared is still refused, and the message now names the key to set (`routing.model_tiers.<runtime>.<model>`) instead of `routing.family_tiers`.
- `routing.family_tiers` is kept as the older spelling of `routing.model_tiers`: a configuration that sets only it routes exactly as before. One model declared under both with different tiers is refused.
