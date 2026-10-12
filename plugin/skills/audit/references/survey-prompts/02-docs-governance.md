## Survey 2 — Documentation governance

Survey how documentation is governed, whatever the maturity: a `docs/` tree, a wiki, scattered READMEs, or nothing.

1. Is there a documented governance model (schema, taxonomy, statuses, lifecycle)? Machine-validated or prose-only?
2. Navigation: index files — hand-maintained or generated? Freshness-gated (a check that fails when the index no longer matches the tree — link-integrity checking alone is not this)?
3. Activity tracking: changelog/log conventions.
4. Decision records: ADRs or equivalent — numbering discipline, evolution/supersession mechanics, any extraction of decisions into mechanical checks.
5. Templates: PRD/architecture/research/ADR templates as files vs copy-from-neighbor.
6. Knowledge loops: retrospectives, session-memory promotion, cross-domain connection docs.
7. Process codification check — do canonical docs exist for: the feature-delivery pipeline (idea → requirements → architecture → design → implementation plan) and the PR lifecycle (branch → review → merge)? Or are these practiced but unwritten?

Synthesize: (A) enforced vs convention-only; (B) practiced-but-uncodified processes; (C) staleness/drift evidence (docs contradicting code or each other); (D) how document versioning/cleanup is handled.

