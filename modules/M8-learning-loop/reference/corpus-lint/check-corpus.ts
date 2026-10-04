// Corpus-lint — the learning loop's invariants, made mechanical.
//
// The eval corpus (see ../../templates/corpus.yaml) is only as trustworthy as
// its discipline. This gate enforces the invariants that keep it honest, so the
// regression corpus never quietly lies about what it proves. Per fixture:
//   1. lever id is `L-NNNN` and UNIQUE across the corpus (parallel authors pick
//      the same next number exactly as with ADRs — guard it the same way).
//   2. category is a member of the miss taxonomy (a typo'd category hides a miss
//      from every count).
//   3. pinned_commit is present (a fixture with nothing pinned tests nothing).
//   4. lens is present (every filed miss is answered by an additive lens).
//   5. required: true  =>  a validated record with a date. This is the
//      validate-then-gate rule: a fixture may not enter the BLOCKING corpus
//      until a live run proved the reviewer now catches it.
//
// Portable: Bun + TypeScript. No shell utilities.
//
// Conventions (see ../../../M1-gates-enforcement-ladder/reference/grep-gate):
// exit 0 on pass, 1 on a violation (per-fixture report), 2 on a usage error.
// CORPUS + TAXONOMY via env/arg so the self-test drives it with fixtures.
//
// Usage:
//   check-corpus.ts corpus.yaml
//   CORPUS=corpus.yaml TAXONOMY=miss-taxonomy.yaml check-corpus.ts
import { runGate } from "../../../../lib/module-gates.ts";

if (import.meta.main) process.exitCode = await runGate("check-corpus");
