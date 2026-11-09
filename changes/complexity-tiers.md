---
release: minor
---

### Added

- An implementer's route now has a complexity tier, `simple`,
  `standard` or `complex`, derived from the issue's type and size facets:
  bugs, improvements and features are standard up to M and complex from L,
  tasks are simple up to L and standard at XL, a spike is complex, and an
  unknown size reads as M. A label in the new `routing.complex_flags`
  (by default `has-migration`, `api-change` and `dpa-relevant`), on the
  issue or declared by an area it seeds, makes an item complex at any size.
  `determine_route.ts` prints the tier, what decided it and, as
  `runtime_model`, the model the runtime is given
  ([CONFIGURATION.md § `routing`](../plugin/CONFIGURATION.md#routing)).
- Claude's and OpenAI's model families are known out of the box, in one
  list a release updates (`plugin/shared/model-families.ts`): `haiku`,
  `sonnet`, `opus`, `fable`, and `luna` (`gpt-6-luna`), `terra`
  (`gpt-5.6-terra`), `sol` (`gpt-6.1-sol`), `astra` (`gpt-6-astra`).
  `routing.models` defaults both runtimes: simple and standard on `sonnet`
  or `terra`, complex on `opus` or `sol`, and a cell a row leaves out
  keeps its default. Codex is given the model id the family names.
- `routing.family_tiers` declares a family's M0 tier where a repository's
  differs, with a reason. The audit reports each entry, and each tier a
  repository maps to a Judgment family (`fable`, `astra`).

### Changed

- **Breaking:** the routing loader refuses a tier mapped to a Scout family
  (`haiku`, `luna`), which no `family_tiers` entry waives; an alias outside
  a runtime's known families; and a row whose stricter tier runs on a
  cheaper family than a lighter one. A repository whose
  `routing.models.codex` names a model id outside the list (`gpt-…`)
  names its family alias instead (`terra`, `sol`), or declares the model in
  `routing.family_tiers.codex` with its tier and a reason.
- A Codex drive pass with no model of its own runs on the standard tier's
  Codex model, `gpt-5.6-terra` by default, rather than Codex's own default.
- The tier names `execution` and `strategic` keep working as `standard`
  and `complex`, in `routing.types`, `routing.models` and
  `drive.pass_model`; a legacy `execution` model also serves the simple
  tier unless the row names `simple`, and a row that names a legacy key
  and its new key with different models is refused.
