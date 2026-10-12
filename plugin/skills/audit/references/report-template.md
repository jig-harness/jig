# Audit report — <target repo> — <date>

> Template. Replace every `<…>`; delete guidance blockquotes. Keep the
> executive summary jargon-free (link the Jig glossary on first use of
> any term of art).

## Executive summary

> 5–10 sentences: overall posture, the 2–3 highest-leverage gaps, the single
> recommended starting point. Written for a reader new to this vocabulary.

## Detected stack

| Facet | Detected | Evidence |
|-------|----------|----------|
| Repo shape | <library / app / service / monorepo — calibrates which practices are expected> | <…> |
| Language(s) / runtime | <…> | <path> |
| Package manager / task runner | <…> | <lockfile / config> |
| CI provider | <…> | <dir> |
| Hook manager | <…> | <config or "none"> |
| Repository-host enforcement | <default branch; protection/rulesets; required checks/reviews; or "unchecked"> | <read-only host query + date> |
| Issue tracker / review bots | <…> | <references> |
| Agent runtimes in use | <…> | <instruction files found> |

## Jig configuration fit

> The `config-fit.ts` findings that need action, each with its `config/<id>`:
> errors first, then contradictions and suggestions. "Not configured" is a
> complete answer for a repository that does not use the plugin's skills yet.

## Module scores

> Score each criterion in the draft record `score.ts --draft` writes, then
> roll up one line per module: the level `record.ts summary` reports and the
> weakest rung that holds it there: absent / convention-only / advisory /
> enforced (see methodology step 3). Mark inapplicable practices
> "expected-absent".

| Module | Score | Evidence (paths) | One-line assessment |
|--------|-------|------------------|---------------------|
| M0 Instruction architecture | absent / convention-only / advisory / enforced | <…> | <…> |
| M1 Gates & enforcement ladder | … | <…> | <…> |
| M2 Generated-artifact freshness | … | <…> | <…> |
| M3–M12 … | … | <…> | <…> |

## Changes since the last audit

> Re-audits only: the `record.ts compare` output, regressions first. List what
> Jig added since the prior audit separately: those are new expectations, not
> lapses. Name each declined recommendation that is due or resolved.

## Gap analysis (ranked: leverage × effort)

> One entry per gap. P1 = high leverage, low-to-medium effort.

### P1-1 <title>

- **Finding**: <what's missing/weak, with evidence paths>
- **Why it matters here**: <consequence in this repo's terms>
- **Recommendation**: <concrete next action in the target's own toolchain>
- **Module / maturity target**: <e.g., M1 Lite>
- **Ref**: <`M1/precommit-autofix-hooks` or `config/<finding>`: what the record names if the team declines it>

## Drift findings

> Contradictions between stated and actual practice: stale instruction files,
> docs referencing retired tools, dangling paths, wrong counts. Include the
> stated claim, the actual state, and both paths.

## Recommended adoption sequence

> Ordered list: module + target maturity rung + rough effort, with
> dependencies noted. Default leverage ordering is M1 → M2 → M0 → M4, but this
> repo's findings override.

## Appendix — survey provenance

> Date, auditor version/commit, which surveys ran, verified vs unchecked
> counts, audited ref/commit, repository-host settings query (or why it was
> unavailable), prior-audit reference if this is a re-audit (with
> fixed/still-open/regressed diff). Record credential findings without copying
> the credential.
