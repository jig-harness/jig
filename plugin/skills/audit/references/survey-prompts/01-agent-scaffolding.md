## Survey 1 — AI-agent scaffolding surfaces

Locate and survey the repo's agent-instruction and scaffolding surfaces, whatever their form: `AGENTS.md`, `CLAUDE.md`, `.cursorrules`/`.cursor/`, `.github/copilot-instructions.md`, `.claude/` (skills, agents, rules, hooks, settings), `.agents/`, MCP config, or none.

1. Instruction files: which exist, their size, their SSoT relationship (does one point to another, or do they duplicate?), nested/per-directory variants.
2. Skills/commands/procedures: inventory and categorize (review gates, environment ops, domain content, meta/self-maintenance).
3. Agent/persona definitions and any model-tiering or cost model.
4. Conditional/path-scoped rule mechanisms.
5. Hooks and automation tied to the agent harness (pre/post tool-use, session lifecycle).
6. Cross-tool interop (can more than one agent runtime discover the same instructions?).

Synthesize: (A) which mechanisms are generalizable patterns vs project-specific content; (B) tacit conventions referenced but not written down; (C) meta-maintenance: what keeps these surfaces themselves fresh (anything? drift examples?); (D) size/token hygiene and observed contradictions between surfaces.

