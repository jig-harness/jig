// Parity report — the learning loop's "measure" step, made mechanical.
//
// The flywheel keeps a lens only if it earns its place, and promotes a reviewer
// to blocking only when measured precision clears a bar (M7's promotion_bar).
// This gate turns a set of reviewer-vs-oracle tallies into those two decisions:
//   * missed_blockers  — a real blocker an oracle caught that the reviewer did
//                        NOT. Any such miss FAILS the gate: it is a regression
//                        signal (open a new lever) and a reason you cannot yet
//                        drop the oracle/vendor that caught it.
//   * precision        — of a reviewer's findings, the share that were real
//                        (TP / (TP + FP)). Reported per reviewer with a
//                        promotable? marker against MIN_PRECISION — this is the
//                        evidence M7 needs before flipping comment -> block.
//
// Input: a tallies file, one reviewer per line, whitespace-separated:
//     <reviewer> <true_positives> <false_positives> <missed_blockers>
// Blank lines and `# comments` are ignored. Produce it from your telemetry /
// weekly parity snapshot (see ../mappings.md).
//
// Portable: Bun + TypeScript. Conventions: exit 0 pass, 1 when a reviewer missed a
// blocker, 2 on a usage / format error. TALLIES via arg/env, MIN_PRECISION via
// env (default 0.90) so the self-test drives it with fixtures.
//
// Usage:
//   check-parity.ts parity.tsv
//   MIN_PRECISION=0.85 TALLIES=parity.tsv check-parity.ts
import { runGate } from "../../../../lib/module-gates.ts";

if (import.meta.main) process.exitCode = await runGate("check-parity");
