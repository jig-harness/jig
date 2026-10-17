# 1 — Principles over tools

Every practice in Jig is stated as a **tool-independent invariant**
first — e.g., "every committed generated file has a regenerate script, a drift
check in CI, and an auto-refresh at commit time" — and only then mapped to
concrete implementations per ecosystem.

**Why.** Tools churn; principles don't. A team on GitLab + Jira + husky must be
able to adopt the same practice as a team on GitHub + Linear + lefthook.
Brownfield projects especially cannot swap their toolchain to adopt a practice
— the practice must meet them where they are.

**Consequences:**

- Each module ships a `mappings.md` table: invariant → implementation notes
  for the tool families the practice touches — agent runtimes (Claude Code /
  Codex / Cursor), issue trackers (Linear / Jira / Dart), hook managers
  (lefthook / husky / pre-commit), CI providers (GitHub Actions / GitLab CI),
  review bots.
- **Derive, don't declare**: tooling should detect a repo's stack from
  observable facts (lockfile → package manager, workflow dir → CI provider)
  instead of demanding configuration. Configuration is only for overriding a
  wrong derivation.
- Reference code in `reference/` is written against Git and GitHub, as
  Bun/TypeScript commands that run on macOS, Linux and Windows (Jig's own
  toolchain, [ADR-0001](../docs/adr/ADR-0001-bun-typescript-toolchain.md)),
  but must isolate tool-specific surface behind small, swappable
  pieces — and say what to swap.
- Runnable tooling (the [plugin](../plugin/README.md)'s skills) may bind to a
  named tool such as Linear or GitHub, provided the binding sits behind an
  interface a second implementation can fill without touching the callers.
  The repository's own values arrive as configuration, never as code.
- A module that cannot yet honor this (mechanism only proven on one stack)
  must say so in its README rather than silently assume the stack.
