---
release: minor
---

### Added

- Skill-authoring rules in [M0 § Skills](../modules/M0-instruction-architecture/README.md#skills): a description leads with the trigger that sets the skill apart and carries its negative triggers, `SKILL.md` names every reference, a reference over 100 lines opens with a table of contents, instruction bodies carry no incident history or time-sensitive phrasing, and discovery controls do what they are for. [What each runtime offers](../modules/M0-instruction-architecture/mappings.md#skill-discovery-controls) is in M0's mappings.
- M0's [skill-authoring check](../modules/M0-instruction-architecture/reference/skill-authoring/README.md) counts the rules a script can see, per rule and per skill file, and prints them as a counter for the ratchet.
- The [ratchet gate](../modules/M1-gates-enforcement-ladder/reference/ratchet/README.md) reads any counting command's JSON (`format: "json"`). With `per: "file"`, each file's count is its own ceiling. It runs the command with `RATCHET_HISTORICAL=1` when it measures the merge base, so a repository can add a counter and the files it counts in one change.
- Two M0 criteria for the audit: `skill-authoring-rules` (Standard) and `skill-authoring-ratcheted` (Strict). Both are expected-absent in a repository with no skills.
