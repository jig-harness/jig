---
release: minor
---

The delivery loop can now be published as one stage map, with a gate that
keeps every owner it names real.

### Added

- **A lifecycle map template** in M6, `templates/LIFECYCLE.md`: one table of
  the delivery loop's named stages (steer, spec, file, plan the epic, pick up,
  implement, pre-PR gates, draft and drive, review rounds, merge, post-merge,
  ops drain, epic close), each with the skill, command or document that owns
  it and the artifact it hands on. M0's `AGENTS.md` skeleton links it, so the
  stage that comes next is one hop from the instructions every session loads.
- **A lifecycle map gate** in M6, `reference/lifecycle-map/`, with a
  self-test: it fails a map whose owner is a skill, script, file or link that
  does not exist, a numbered, unowned or placeholder stage, an instruction file
  that does not link the map, and, with `--cover`, a skill on no stage. With
  `--scan` it fails any document that names a plugin skill that does not exist.
- **Three audit criteria** for M6 (`lifecycle-map-published`,
  `lifecycle-owners-resolve-gated`, `lifecycle-skills-on-the-map`), scored
  in Jig's record and the calibration record.
- The skills table in the plugin README points to the lifecycle map for the
  order in which the skills are used.
