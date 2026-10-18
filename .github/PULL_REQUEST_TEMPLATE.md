<!-- One cohesive change (CONTRIBUTING.md). Keep the headings; replace the text. -->

## What and why

<!-- What changes for someone who uses Jig, and the problem it solves. Link the issue if there is one; keep tracker keys and internal links out of commit messages. -->

## The audit

<!-- Every change re-evaluates the audit skill: what changed in config-schema.yaml, the criteria or config-fit.ts, or why nothing needed to (CONTRIBUTING.md § Keeping the auditor current). -->

## Checklist

- [ ] `bun run gates` passes
- [ ] A change note under `changes/` (with `release:` when `plugin/` changed)
- [ ] Every commit is signed off (`git commit -s`) if you are not a maintainer
- [ ] Nothing names an organization's own material, keys or values
