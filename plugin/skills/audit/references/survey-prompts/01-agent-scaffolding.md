## Survey 1 — AI-agent scaffolding surfaces

Your modules (the answers you return): M0.

Locate and survey the repo's agent-instruction and scaffolding surfaces, whatever their form: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`/`.cursor/`, `.github/copilot-instructions.md`, `.claude/` (skills, agents, rules, hooks, settings), `.agents/`, MCP config, or none.

1. Instruction files: which exist, their size, their SSoT relationship (does one point to another, or do they duplicate?), nested/per-directory variants. For each tool-specific file, what its runtime loads natively (from the repository's load model where one is recorded): an import of a file the runtime already loads would load it twice.
2. Skills/commands/procedures: inventory and categorize (review gates, environment ops, domain content, meta/self-maintenance). Where skills exist, find the written authoring rules (descriptions and negative triggers, references named by the entry file, history and time-sensitive phrasing, discovery controls) and any check that counts them per file.
3. Agent/persona definitions and any model-tiering or cost model.
4. Conditional/path-scoped rule mechanisms.
5. Hooks and automation tied to the agent harness (pre/post tool-use, session lifecycle).
6. Cross-tool interop (can more than one agent runtime discover the same instructions?).
7. Runtime-specific capabilities: slash commands for skills outside a plugin, built-in tools (a question tool, a subagent tool) and tools a launcher or workspace app injects, each with or without its fallback beside it; any gate, hook, script or skill step that depends on an injected tool. Deny lists per runtime (`.claude/settings.json` `permissions.deny`, `.codex/rules/*.rules`), the policy each names and the gaps each lists.
8. Scope and stances: whether each standard names the artifact classes it governs (runtime code, one-shot tools, tests, instruction files), and whether settled review stances are pointers to one source or restated in reviewer configuration.

Synthesize: (A) which mechanisms are generalizable patterns vs project-specific content; (B) tacit conventions referenced but not written down; (C) meta-maintenance: what keeps these surfaces themselves fresh (anything? drift examples?); (D) size/token hygiene and observed contradictions between surfaces.

