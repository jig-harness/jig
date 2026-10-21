---
release: minor
---

### Added

- [M0](../modules/M0-instruction-architecture/README.md#invariant) states new invariants. Instructions are portable: one that relies on a capability only some runtimes have (a slash command, a built-in tool, a tool the host injects, a permission rule) names its fallback, and a host-injected tool is never a dependency. Rules declare their scope: each standard names the artifact classes it governs, and standing review stances point to their one source instead of restating it.
- M0's [mappings](../modules/M0-instruction-architecture/mappings.md#runtime-specific-capabilities-and-their-fallbacks) list each runtime-specific capability with its fallback per runtime: how to run a skill without its slash command, the order for asking the user, the deny-list formats of Claude Code and Codex with the command forms each cannot match, and tools the host injects.
- A [skill-invocation fallback lint](../modules/M0-instruction-architecture/reference/skill-invocation-fallback/README.md), an M0 reference gate that fails a `/<skill>` with no fallback for that skill beside it.
- The AGENTS.md skeleton gains *Standards scope by artifact class* and *Standing review stances* sections.
- M0 audit criteria at Standard: `runtime-capabilities-name-fallbacks`, `deny-lists-per-runtime`, `standards-declare-scope` and `review-stances-are-pointers`; at Strict: `skill-invocation-fallback-gated`. A re-audit reports them as added by Jig.

### Changed

- `do-item`, `file-issue` and `work-batch` say what to do when nobody is there to answer a question: stop and state it. `do-item` names a fallback for delegating where the harness has no Task tool, and `fix-ci` for tracking errors where it has no task list.
