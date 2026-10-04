# Shared agent procedures

Agent procedures should have one maintained source so every runtime uses the
same instructions. Future extracted skills live at `skills/<name>/SKILL.md`,
with private helpers and references beside each skill. Shared executable code
belongs in [tools/](../tools/) or `lib/`.

No skill is moved in this toolchain change. The installer will define how a
pinned checkout exposes these procedures to each agent runtime.
