---
release: minor
---

### Added

- `do-item` now says which [route](../GLOSSARY.md) the agent that
  implements an item would run on: the agent, the model tier (Execution or
  Strategic), the effort and the runtime's model, each with the rule behind
  it, in the status message, such as
  `Route: execution, high, sonnet (flag has-migration raised medium)`. The
  base comes from the item's work type; a flag label, an area with a
  mandatory review, a size too large to batch and the human-in-the-loop
  label each move the effort up one step, never past `max`; an item whose
  type is `unknown` takes the strictest row. The new `determine_route.ts`
  script derives it. Nothing is forwarded to the implementer in this
  version, so no repository's model changes. See
  [do-item's README](../plugin/skills/do-item/README.md#the-implementers-route).
- A `routing` section in `.config/jig.yaml` holds the rules as data: each
  work type's base tier and effort, which flags and sizes raise the effort,
  whether a mandatory review does, and each runtime's family alias per tier
  and spelling per effort (by default Claude Code's `sonnet` for Execution
  and `opus` for Strategic). Without the section the route is still derived
  and reported; `routing: {}` opts in with every default. See the
  [configuration reference](../plugin/CONFIGURATION.md#routing).
