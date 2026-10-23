# Portfolio audit — <portfolio> — <date>

> Template. Complete one normal audit per repository first. This report holds
> only conclusions that become clearer by comparing those audits.

## Executive conclusion

> Overall posture, urgent cross-repo risks, the most valuable shared
> capability to establish, and the universal lessons that flow back into
> Jig.

## Audit basis

| Repository | Role / shape | Audited branch and commit | Default branch | Host enforcement checked? |
|------------|--------------|---------------------------|----------------|---------------------------|
| <repo> | <…> | <branch @ commit> | <…> | <date / unchecked> |

## Urgent findings

> Security, data-loss, broken-promotion, or unenforced-default-branch findings
> that should not wait for the shared-capability program. Never reproduce a
> credential.

## Per-repository posture

| Repository | Strongest practices | Highest-leverage gaps | Detailed scorecard |
|------------|---------------------|-----------------------|--------------------|
| <repo> | <…> | <…> | <link> |

## Shared-capability matrix

| Capability | Current sources and consumers | Drift / missing enforcement | Recommended maintained home |
|------------|-------------------------------|-----------------------------|-----------------------------|
| <e.g. issue-tracker policy> | <…> | <…> | <…> |

For each proposed shared capability, state what remains local. A central
package should not own repository paths, deployment secrets, or application
review lenses.

## Proposed organization-owned package or repository

> Purpose, boundaries, versioning and distribution model, ownership, update
> policy, and a minimal first slice. Keep existing executable services in
> their own repos and integrate them rather than absorbing them.

## Jig backflow

| Finding from live use | Universal lesson | Jig change or explicit no-port decision |
|-----------------------|------------------|-----------------------------------------------|
| <…> | <…> | <…> |

Also list improvements to Jig's own maintenance separately from module
content, such as branch enforcement, status-freshness design, or auditor
automation.

## Recommended sequence

> Ordered actions with owner type, dependencies, and rough effort. Separate
> immediate repo fixes, shared-capability work, and Jig backflow.

## Human decisions requested

> New repository creation, visibility, licensing, branch-policy changes,
> credential rotation, or other decisions the auditor deliberately did not
> make.

## Appendix — provenance

> Auditor commit, exact target refs, clean-snapshot method, survey execution,
> host queries, known unchecked surfaces, and prior portfolio audit if any.
