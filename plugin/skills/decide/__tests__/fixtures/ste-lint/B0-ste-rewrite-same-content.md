## The decision

The price-list importer reads a product row from the supplier's export. The product row cites a supplier catalogue entry. Sometimes our pricing rule for that entry has a different list price or discount than the export.

When the user makes no choice, the import uses **the catalogue rule**. It sets `pricing_rule_id` and leaves the custom values empty. It raises a warning (`price_mismatch` or `discount_mismatch`), and the wizard shows it. The catalogue value wins unless the user picks "use supplier values".

When the SKU and the URL of a citation disagree, the import still treats the citation as an exact match at confidence 1.0. It adds a `citation_mismatch` warning.

## Why this needs a decision

This default can make a price lower than the supplier's own system says. Example: the export says Full price, and the catalogue rule says Clearance. For a shop that sells at a margin, that is the unsafe direction.

Our catalogue seed is also being corrected (the catalogue data-quality issue).

The default keeps the behaviour the importer had before. Nobody chose it for pricing reasons.

## Options

For each option, state what you keep, what you pay, and when it is right.

1. **Catalogue wins** (current). The wizard shows the mismatch as a warning, and the user must acknowledge it.
2. **Supplier wins.** Use the export's values when they differ. Link the catalogue rule only when they agree.
3. **Fail-safe.** For each rule, take the more conservative value: the higher price, and full price over clearance. Mark the rule `needs_review`.
4. **Block.** The import does not run until each mismatch has an explicit choice.

Also decide for API callers, who have no wizard: must an import with a mismatch and no override fail?
