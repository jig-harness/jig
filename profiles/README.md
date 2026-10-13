# Profiles

A profile is a recommended composition: which modules, at which maturity
level, for a project shape. Profiles are starting points, not contracts — the
[audit](../plugin/skills/audit/README.md) report's recommendations override generic profile advice
for brownfield projects.

Every module (M0–M12) carries machine-readable maturity criteria, so a
profile's target resolves to concrete criteria: "M1 Lite" means passing every
`level: lite` criterion in
[`M1-gates-enforcement-ladder.yaml`](../plugin/skills/audit/criteria/M1-gates-enforcement-ladder.yaml),
and likewise per module — the criteria live only there (single source of
truth), so profiles name levels, never restate criteria. The levels below
are also in machine-readable form, in
[`plugin/skills/audit/profiles.yaml`](../plugin/skills/audit/profiles.yaml),
with the order to adopt modules in: the audit reads that file to show each
module's target and what is left to reach it. This page keeps the reasoning;
the file and this page change together. The
[audit skill](../plugin/skills/audit/README.md) reads the same criteria to
score a repository and reports the level each module attains.

## Choosing

| Question | If yes → |
|----------|----------|
| Throwaway or single-person, short-lived? | Solo/Lite |
| Will a team maintain this in production? | Team/Standard (minimum) |
| Regulated domain, compliance posture, or audit obligations? | Regulated/Strict |

Graduate when the answer changes — profiles are stages, not identities.

## Solo/Lite

The minimum that keeps an AI-assisted repo coherent. **M0 Lite** (one
instruction file + glossary), **M1 Lite** (documented gate set + CI running
it), **M2 Lite** (derived-file inventory). Everything else: skip until it
hurts. Rationale: even a weekend project benefits from agents that know the
rules and a CI that runs the gates; nothing else pays for itself yet.

## Team/Standard

Production software, multiple contributors (human or agent). M0–M2 Standard;
**M4 Standard** (docs governance); **M5 Standard** (ADRs); **M6/M7 Standard**
(delivery pipeline + PR lifecycle with layered review); **M9 Lite→Standard**
(tracker labels that drive process); **M12** if using parallel agent
workspaces. M3 (change-area catalog) once the repo is big enough that "what
does this change imply?" stops being obvious.

## Regulated/Strict

Everything in Team/Standard at Strict where defined, plus: **M1 Strict**
(suppression-token registry, review markers), **M0 Strict** (instruction
freshness checked, a named owner), **M7 Strict** (HITL decision registry,
merge reserved to humans), **M8** (learning loop with regression corpus), **M10 Standard+**
(verify-then-promote, environment separation), **M11** (process
observability/audit trails). Compliance artifacts (data-processing registers,
threat models) are out of Jig's scope but hook into M4's governance and
M9's flag labels (e.g., a "privacy-relevant" label firing a register-update
gate).
