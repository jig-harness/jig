# Shared agent procedures

Agent procedures should have one maintained source so every runtime uses the
same instructions. Extracted skills live at `skills/<name>/SKILL.md`,
with private helpers and references beside each skill. Shared executable code
belongs in [tools/](../tools/) or `lib/`.

[resolve-review-comments](resolve-review-comments/README.md) is the first pilot.
The [installer](../tools/install/README.md) exposes pinned procedures to both
agent runtimes; consumer-owned policy arrives through its overlay.
