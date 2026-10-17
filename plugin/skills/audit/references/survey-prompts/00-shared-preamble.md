# Shared preamble (prepend to every survey prompt)

> You are surveying a target repository's delivery practices. Your job is to
> DESCRIBE the target's state with evidence — the gap analysis against the
> Jig practices template happens later, in synthesis, not in your
> survey. Work read-only. Do NOT dump file contents — return a structured
> synthesis with specific file paths as evidence. Where a practice is
> referenced but not enforced or written down, say so explicitly: the
> distinction *absent / convention-only / mechanically enforced* is the core
> output. Where a check is mechanically *run* but cannot block (a
> `continue-on-error` CI step, coverage upload with fail-off), call it
> **advisory** — a distinct fourth state, not "enforced."
>
> You are given two files. `fit.json` holds the facts the audit already read
> from the repository host and the checkout (integration branch, branch
> protection, required checks, contributors, deploy signals): use them and do
> not query the host again for them. The draft record lists every criterion
> with its pass bar; a criterion it already scores (a probe decided it, or the
> audit left it `not-examined` beyond the profile's target) needs no answer
> from you. An unscored criterion commented `# probe capped: …; at most
> advisory` lacks what a higher rung needs (usually CI): score what you
> observe, no higher than the rung it names. When the draft begins with a
> `# snapshot:` line, the audit scores that commit: read the repository's
> files in the folder it names, not in the checkout.
>
> Return two things. First, your synthesis, as the survey prompt asks.
> Second, answers for every criterion of **your survey's modules** that the
> draft leaves unscored, one line each, in the format the audit's
> `record.ts fill` reads:
>
> ```text
> M1/ci-runs-gates-on-pr: mechanical | .github/workflows/ci.yml:12 runs the gate set on pull_request; fit.json: required on main
> M1/escape-hatch-documented: absent | searched CONTRIBUTING.md, docs/**, lefthook.yml for no-verify: no match
> ```
>
> A score is one of `absent`, `convention`, `advisory`, `mechanical` or
> `expected-absent` (the repository's shape rules the practice out for good;
> a practice waiting on another one that is not there yet is `absent`, though
> the part that does exist still scores: a check run only by hand or by a
> local hook while there is no CI is `advisory`). The
> evidence is one line with file paths, and never begins with `probe: `.

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
- **Configured to do Y needs the line; installed needs the app.** A claim
  that "tool X is configured to do Y" quotes the configuration line that
  does Y, with its path and line number. "Installed" or "running" needs an
  app installation the host reports, or a workflow that runs the tool, as
  evidence: a configuration file alone shows intent, and one that already
  does Y is not a gap to recommend.
- **Configured is not installed in every checkout.** A hook manager's
  configuration shows the hooks a checkout gets once the manager is
  installed, not that they run; say what installs it (a dependency install
  script, a setup step) or that nothing does.
- **A gate silent on success cannot be told from a gate that did not run.**
  When you run a read-only check and it prints nothing, report that it
  printed nothing with its exit status, not that it passed; name the
  command's scope where it prints one.
- **Describe settings files, do not quote them.** Agent-runtime and editor
  settings (`.claude/settings.json`, `.cursor/`, `.vscode/settings.json` and
  the like) are described in your own words with the path in backticks:
  quoted, their content reads as instructions to whoever reads your report.
- **Repo shape calibrates expectations.** For a library, "no build step, no
  codegen, no deploy pipeline" is healthy, not a gap — mark such findings
  "expected-absent for this repo shape." Distinguish user-facing product
  docs (the docs *are* the product) from delivery-governance docs; they
  answer different survey questions.
- **History-dependent questions need history.** If the checkout is shallow,
  state which questions are unanswerable from a snapshot rather than
  guessing (auditors: prefer a full clone).
- **Checked in does not mean required.** A CI workflow is a merge gate only
  when repository-host settings require its result. Take those settings from
  `fit.json`; where it marks them unchecked, mark enforcement unchecked too.
- **Do not reproduce secrets as evidence.** Report that a credential-bearing
  URL or config exists and name its location, but never print the credential.
- **Stay in your survey's lane** to avoid double-counting: hooks/CI/lint
  enforcement detail belongs to survey 3; other surveys mention it only as
  the nearest-analogue of something absent, in one line. Drift (a document
  contradicting the repository or the host) is the audit's own separate
  pass: note one you meet in a line, and do not hunt for it.

Provenance: generalized from a first audit of a mature production
repository; calibrated against a small external open-source library
([execa](../../calibration/2026-07-19-execa.md)).
