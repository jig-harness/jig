---
release: minor
---

### Added

- Conflict hotspots enter the learning loop. `reflect.ts hotspots <report.json>` in the [`reflect` skill](../plugin/skills/reflect/README.md) reads the merge-conflict history report (`history.ts --json` of [`resolve-conflicts`](../plugin/skills/resolve-conflicts/SKILL.md#hotspots-into-the-learning-loop)) and notes one reflection finding per hotspot: the path as its target, its most frequent cause (`append`, `tally`, `overlap`, …) as its class, and the report's remedy as its fix, with what the measurement could not see (skipped merges, the cause's hand-checked accuracy). A cause that recurs across files therefore escalates to one tracker issue through `reflect`'s existing plan and `/jig:review-reflections`, with no second escalation path. Measuring again revises a finding the journal still holds rather than adding one, and adds nothing for a hotspot the store already records until its fix is implemented and a later range measures it again. With reflection off it says so and writes nothing.
- [M12](../modules/M12-parallel-agent-ergonomics/README.md)'s merge-conflict practice says how measured hotspots reach the learning loop, and its audit criterion counts a hotspot's reflection finding as planned work once escalated or approved, and as a keep decision only once dismissed with a reason that keeps the cause on purpose and names when to revisit it.
