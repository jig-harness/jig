<!--
  TEMPLATE — copy this file to your repo root as GLOSSARY.md (or CONTEXT.md)
  and replace the example entries with your domain's terms.

  Authoring notes (delete once read):
  - Keep it to ONE short page. The glossary works because agents actually
    read it; a long one gets skimmed and stops working.
  - One entry = the canonical term, a one-to-three-sentence definition of
    what the concept IS, and an explicit "_Avoid_" list of the aliases
    people actually use for it. The Avoid list is the load-bearing part:
    parallel agents routinely pick different words for the same concept
    ("ticket"/"issue", "purge"/"delete"), which causes spec drift,
    duplicated issues, and code that disagrees with itself across packages.
    Naming the losers is the cheapest known fix.
  - Definitions only, never implementation. It's a glossary, not a spec —
    "how" lives in code, decision records, and design docs.
  - Group entries by domain area so the page scans in seconds.
  - Genuinely unsettled terms go in "Flagged ambiguities" — agents must not
    silently pick a winner there. When a term settles, promote it into the
    body and remove the bullet.
  - Point your universal instruction file (AGENTS.md) at this page, and —
    if your runtime supports conditional rules — add a small always-relevant
    rule that reminds agents to use canonical terms and flag Avoid aliases
    (scope it to source and docs files; see templates/rules-README.md).
-->

# <Project> — Domain glossary

The opinionated, one-screen vocabulary every agent and contributor should
use when reasoning about <Project> concepts. Read this before any spec,
decision record, issue, code comment, or PR description.

**Discipline**: when multiple words exist for the same concept, pick the
canonical one and call out the aliases as **_Avoid_**. If you catch
yourself or a teammate using an "avoid" term, propose the canonical one in
the same response. If you add a new domain concept an agent will need to
reason about, add it here in the same PR.

This is a **glossary, not a spec**. It defines what concepts *are*, never
*how* they are implemented.

---

## <Domain area, e.g. Ordering>

**Order**:
<!-- Example entry — replace. -->
A customer's request to purchase, from placement through fulfillment. Has
an `order_status` lifecycle: `draft → placed → fulfilled → closed`.
_Avoid_: purchase, basket (that's the pre-order cart), transaction

**Invoice**:
<!-- Example entry — replace. -->
The billing document issued for one or more fulfilled orders. An invoice
references orders; it is not itself an order.
_Avoid_: bill, receipt (a receipt confirms payment; an invoice requests it)

## <Domain area 2>

**<Term>**:
<Definition — what it is, its key lifecycle or table if that anchors it.>
_Avoid_: <alias 1>, <alias 2 (why it's reserved for something else, if so)>

---

## Flagged ambiguities (terms not yet canonical)

These are genuinely unsettled — agents must not silently pick a winner.
Flag the ambiguity in the moment and ask, or stick to the closest neighbor
above.

- **<term A> vs <term B>** — <where each is currently used>.

When you resolve one (in a spec, decision record, or implementation
decision), promote it into the body of this file and remove the bullet.

---

**Maintenance**: if you find a term-naming disagreement in a code review,
propose the canonical form here, not just in the diff.
