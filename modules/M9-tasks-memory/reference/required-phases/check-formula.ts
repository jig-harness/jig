// Required-phases gate — a phase formula's REQUIRED gates, made mechanical.
//
// A phase formula (see ../../templates/phase-formula.yaml) declares the phases a
// class of recurring multi-phase work must pass, marking some `required: true`.
// This gate refuses to let a work item be CLOSED with a required phase skipped —
// the same "validate-then-gate" shape as M8's corpus (you may not claim done
// until the required step is on record).
//
// Two inputs:
//   RECORD  ($1 or RECORD=) — a work-item phase record: a `status: <value>` line
//            plus the completed phase ids, one per line. Blank lines and `#`
//            comments are ignored; a `phase:` prefix or a leading `- ` is fine.
//   FORMULA ($2 or FORMULA=, default `phase-formula.yaml` beside the record) —
//            the formula declaring which phases are `required: true`.
//
// If the item's status is a DONE state (DONE_STATES, default "done closed
// merged"), every required phase must appear in the record; a missing one FAILS.
// A non-done item passes — it is not yet claiming completion, so there is
// nothing to gate.
//
// Portable: Bun + TypeScript. No shell utilities.
//
// Conventions (see ../../../M1-gates-enforcement-ladder/): exit 0 on pass, 1 when
// a required phase is skipped at close, 2 on a usage/format error. Inputs via
// arg/env so the self-test can drive fixtures.
//
// Usage:
//   check-formula.ts record.txt phase-formula.yaml
//   RECORD=record.txt FORMULA=phase-formula.yaml check-formula.ts
import { runGate } from "../../../../lib/module-gates.ts";

if (import.meta.main) process.exitCode = await runGate("check-formula");
