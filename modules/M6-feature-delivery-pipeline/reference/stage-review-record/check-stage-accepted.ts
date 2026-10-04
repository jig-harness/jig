// Stage-review-record gate — an accepted artifact proves it was reviewed.
//
// The pipeline invariant: an artifact is adversarially reviewed (fresh context,
// red-team posture) BEFORE the next stage consumes it. "Consumable" is marked in
// frontmatter as `status: accepted`. This gate makes the review non-skippable:
// an artifact that claims `status: accepted` MUST also carry a review record.
//
// A review record is EITHER:
//   * a `reviewed:` frontmatter key whose value carries a reviewer plus an
//     anchor proving when/where — a date (YYYY-MM-DD), an issue/PR ref (#123), a
//     URL, or a commit sha; a bare `reviewed: true` does not count, OR
//   * a non-empty `## Review` section in the body (a heading whose text starts
//     with "Review", followed by at least one non-blank content line).
//
// Verdict:
//   status not accepted (draft / proposed / absent)  -> pass  (nothing to prove)
//   status accepted WITH a review record             -> pass
//   status accepted WITHOUT a review record          -> FAIL  (exit 1)
//   frontmatter opened with `---` but never closed   -> error (exit 2)
//
// De-scarring (M4) keeps the finished artifact clean, so the record stays terse
// — a reviewer and an anchor, not the review dialogue. Input: the artifact via
// arg 1 or ARTIFACT env. Conventions: exit 0 pass, 1 accepted-but-unreviewed, 2
// usage/format error.
//
// Usage:
//   check-stage-accepted.ts prd.md
//   ARTIFACT=prd.md check-stage-accepted.ts
import { runGate } from "../../../../lib/module-gates.ts";

if (import.meta.main) process.exitCode = await runGate("check-stage-accepted");
