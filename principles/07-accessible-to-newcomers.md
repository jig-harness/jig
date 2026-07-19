# 7 — Accessible to newcomers

Groundwork assumes **no prior familiarity** with any of the techniques it
packages. A reader meeting "SSoT," "drift gate," or "HITL" for the first time
must be able to use this repo without outside context.

**Consequences (binding on all groundwork content):**

- A root [GLOSSARY.md](../GLOSSARY.md) defines every term of art in plain
  language. New terms are added in the same commit that introduces them.
- Documents expand jargon on first use and link the glossary.
- Every module README opens with a plain-language paragraph: *what problem
  this solves and what it looks like without it* — before any mechanism
  detail.
- Examples favor neutral, recognizable situations over insider references;
  acronyms are spelled out once per document.
- Depth is layered: a reader should get the idea from the README opener, the
  practice from the invariant + adoption steps, and the mechanics only if they
  open `reference/`.

**Why.** The audiences that benefit most from these practices — small teams,
solo builders, brownfield maintainers — are exactly the audiences least likely
to already share the vocabulary. Accessibility is also a forcing function for
clarity: a practice that can't be explained plainly usually isn't understood
by its authors either.
