## The decision

In the price-list importer, when a product row cites a supplier catalogue entry and our pricing rule for it differs from the export's own list price/discount, the effective default with no explicit user choice is **the catalogue rule** (`pricing_rule_id` set, custom values null); a warning (`price_mismatch` / `discount_mismatch`) is raised and the wizard shows it, but the catalogue value wins unless the user picks "use supplier values". A SKU/URL citation mismatch still resolves as an exact match at confidence 1.0 (with a `citation_mismatch` warning).

That default can lower prices relative to what the supplier's own system says (e.g. source says Full price, catalogue rule says Clearance) — the unsafe direction for a shop that sells at a margin — and our catalogue seed is itself being corrected (the catalogue data-quality issue). It was chosen to preserve the pre-existing behaviour; it was not decided on pricing grounds.

## Options to weigh (per option: what you keep, what you pay, when it is right)

1. Keep: catalogue wins, mismatch is a warning the user must acknowledge in the wizard.
2. Supplier wins: use the export's own values whenever they differ, link the catalogue rule only when they agree.
3. Fail-safe: take the more conservative of the two per rule (higher price; full price over clearance) and flag the rule `needs_review`.
4. Block execute until every mismatch has an explicit choice.

Also decide for API callers (no wizard): does a mismatch without an override reject the import?
