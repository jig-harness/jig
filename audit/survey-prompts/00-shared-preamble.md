# Shared preamble (prepend to every survey prompt)

> You are surveying a target repository's delivery practices. Your job is to
> DESCRIBE the target's state with evidence — the gap analysis against the
> groundwork practices template happens later, in synthesis, not in your
> survey. Work read-only. Do NOT dump file contents — return a structured
> synthesis with specific file paths as evidence. Where a practice is
> referenced but not enforced or written down, say so explicitly: the
> distinction *absent / convention-only / mechanically enforced* is the core
> output. Where a check is mechanically *run* but cannot block (a
> `continue-on-error` CI step, coverage upload with fail-off), call it
> **advisory** — a distinct fourth state, not "enforced."

Calibration rules (learned from audit runs):

- **A uniformly "absent" area is a valid, expected finding** — common in
  small or pre-agent-era OSS targets. Report the nearest existing analogue
  (CI config, lint setup, CONTRIBUTING, readme) in a line or two and move
  on; do not manufacture nuance to fill an empty area, and treat "N/A —
  fewer than two of these exist" as a complete answer where a question
  presumes plurality.
- **Evidence a negative claim with the search, not a path**: name the globs
  and greps you ran and the closest files that *do* exist.
- **Mentioned ≠ wired in.** A vendor name in a readme, sponsor logo, or
  badge is not a configured tool. Claim a bot/tool is in use only with its
  config file or workflow step as evidence.
- **Repo shape calibrates expectations.** For a library, "no build step, no
  codegen, no deploy pipeline" is healthy, not a gap — mark such findings
  "expected-absent for this repo shape." Distinguish user-facing product
  docs (the docs *are* the product) from delivery-governance docs; they
  answer different survey questions.
- **History-dependent questions need history.** If the checkout is shallow,
  state which questions are unanswerable from a snapshot rather than
  guessing (auditors: prefer a full clone).
- **Stay in your survey's lane** to avoid double-counting: hooks/CI/lint
  enforcement detail belongs to survey 3; other surveys mention it only as
  the nearest-analogue of something absent, in one line.

Provenance: generalized from the founding audit (2026-07-18, run against the
reference implementation — the run that produced
[the charter](../../docs/founding-charter-2026-07-18.md)); calibrated against
a small external OSS library (execa, 2026-07-19).
