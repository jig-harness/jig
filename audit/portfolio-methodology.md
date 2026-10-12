# Portfolio audit methodology

Auditing related repositories one at a time can miss the most expensive
problems: a policy copied five times and maintained nowhere, a required check
that only one repo actually requires, or a useful capability trapped inside
an application repo. A portfolio audit adds a comparison pass after each repo
has been audited on its own shape. It does not average unlike repositories or
turn organization-specific choices into universal Groundwork content.

## 1. Freeze a comparable audit basis

Record every target repository, the branch that actually receives day-to-day
changes, and the exact commit audited. Use clean, read-only snapshots of those
refs so uncommitted developer work is neither overwritten nor mistaken for
repository policy. Record the repository's default branch separately: it may
not be the active integration branch.

Verify repository-host settings at the same time where read-only access is
available. Branch protection, rulesets, required checks and human reviews,
conversation resolution, and bypass actors are portfolio evidence even though
they do not live in the checkout.

## 2. Complete each repository audit

Run [methodology.md](methodology.md) and score every M0–M12 criterion for each
repo before comparing them. Preserve `expected-absent` results: a deploy gate
can be essential for an application and irrelevant to a documentation-only
repo. Portfolio conclusions must not punish a repository for having a
different job.

Use the same evidence vocabulary in every report:

- **present and required** — checked in and required by CI or repository-host
  policy;
- **present but advisory** — runs or reports, but cannot stop the change;
- **convention-only** — written or practiced without mechanical enforcement;
- **absent** — expected or a gap, stated explicitly;
- **unchecked** — evidence lives outside the available access.

## 3. Compare shared capabilities

Build a capability matrix rather than a file-count comparison. Useful rows
include agent skills, issue-tracker policy, documentation placement, review
automation, CI supply-chain policy, repository templates, local-development
bootstrap, deployment conventions, observability services, and external
knowledge tools.

For each capability, answer:

1. Which repo currently acts as the source?
2. Which repos contain copies or partial reimplementations?
3. Are the copies byte-identical, intentionally specialized, or silently
   divergent?
4. What parts are universal mechanism, organization policy, executable
   product, and repo-local configuration?
5. Which enforcement point can prove consumers are current?

Hashing copied files is useful negative evidence, but a differing hash is only
a lead. Read the differences before calling them drift; repo-local parameters
may be intentional.

## 4. Choose the right maintenance home

Place each finding by what it is, not by where it happened to be discovered.

| Kind | Maintained home |
|------|-----------------|
| Universal, tool-independent delivery invariant | Groundwork module, template, mapping, or auditor |
| Generic runnable mechanism (an agent skill, a review loop, a gate) | The Groundwork plugin, with each organization's values as configuration |
| Organization-specific policy or supported-tool catalog | A separate organization-owned standards package or repository |
| Executable service used across repositories | Its own versioned service or product repository |
| Repo-specific paths, environments, secrets, or reviewer lenses | The consuming repository |
| Secret value | A secret manager; never the standards repo or audit report |

The organization-specific home should distribute versioned assets rather than
invite hand-copying. Depending on the asset, that can mean reusable CI
workflows, pinned actions, an agent-skill package, a bootstrap command, or a
generated repo overlay. Consumers keep small local configuration and a
machine-checkable version or freshness record.

Groundwork must remain useful without access to that organization-specific
home. Bring in only the corrected, reusable invariant, with product content
and private values removed.

## 5. Synthesize one portfolio conclusion

Use [portfolio-report-template.md](portfolio-report-template.md). Lead with
portfolio-wide risks and decisions, then link the per-repo scorecards. Keep
three queues distinct:

- urgent repository fixes, including credential rotation and unsafe release
  ordering;
- shared-capability work that needs an organization-owned home;
- universal backflow that improves Groundwork or its own maintenance.

Do not create a new repository, choose its visibility or license, rotate a
credential, or change protected-branch policy as an audit side effect. Those
are explicit human decisions. The audit should make each decision small by
providing the proposed scope, boundaries, and first adoption slice.
