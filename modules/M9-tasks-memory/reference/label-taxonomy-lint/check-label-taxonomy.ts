// Label-taxonomy lint — the tasks-&-memory invariant, made mechanical.
//
// A label taxonomy (see ../../templates/label-taxonomy.yaml) is the SSoT for how
// work is classified and, crucially, which process each flag label FIRES. This
// gate keeps that file honest so labels stay process triggers, not folksonomy.
// It checks a label-taxonomy.yaml:
//   1. every label `id:` (under types, statuses, or flags) is UNIQUE across the
//      whole file — a collision makes a label ambiguous.
//   2. `types:` and `statuses:` are CLOSED, NON-EMPTY lists — the mandatory
//      vocabulary every issue draws from (an absent or empty list classifies
//      nothing, so an issue could carry no type or no status at all).
//   3. every entry under `flags:` declares a NON-EMPTY `fires:` — a flag label
//      with no process trigger is folksonomy, which this module bans.
//   4. no UNKNOWN top-level keys (the schema is version/types/statuses/flags).
//
// Portable: Bun + TypeScript. No shell utilities.
//
// Conventions (see ../../../M1-gates-enforcement-ladder/): exit 0 on pass, 1 on a
// violation (reported), 2 on a usage/format error. TAXONOMY via arg/env so the
// self-test can drive it with fixtures.
//
// Usage:
//   check-label-taxonomy.ts label-taxonomy.yaml
//   TAXONOMY=label-taxonomy.yaml check-label-taxonomy.ts
import { runGate } from "../../../../lib/module-gates.ts";

if (import.meta.main) process.exitCode = await runGate("check-label-taxonomy");
