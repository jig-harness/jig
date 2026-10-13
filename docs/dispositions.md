# Dispositions

How an agent or contributor working on Jig leans when several approaches
are viable and no rule in [AGENTS.md](../AGENTS.md) decides. Without these
written down, every session re-derives Jig's stance or guesses it, and a
stance that suited an earlier stage keeps applying after its reason is gone.
Each default is therefore one of Jig's [dispositions](../GLOSSARY.md): it
names the condition that changes it.

A default that never changes is a rule and belongs in AGENTS.md. The
decisions that need a person, the [human-in-the-loop (HITL)](../GLOSSARY.md)
list and loosening the [ratchet](../GLOSSARY.md), are such rules: nothing on
this page relaxes them.

- **Systematic over improvised**: follow the workflow, turn a rule into a
  check rather than rely on care, and fix a failing check's cause rather than
  bypass it. *Changes when* a person asks for a spike or a prototype; say in
  the pull request that it is one.
- **One implementation behind an interface**: runnable tooling binds to one
  named tool (AGENTS.md's writing conventions). *Changes when* a consumer
  needs a second tool; build that implementation then, not before.
- **Leave the unproven out**: dark-by-default dials, unvalidated eval
  fixtures and aspirational hooks are noted as future in the module README.
  *Changes when* a working repository has validated them.
- **Derive before declaring**: detect a repository's stack and facts rather
  than ask for configuration. *Changes when* a fact cannot be derived
  reliably; then it becomes a configuration field.
- **Breaking changes ride a minor version**: before 1.0.0, a minor plugin
  version may change what consumers rely on, marked **Breaking** with what to
  change. *Changes at* 1.0.0, from which a breaking change needs a major
  version.
