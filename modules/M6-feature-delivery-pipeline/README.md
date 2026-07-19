# M6 — Feature-delivery pipeline (stub)

**What problem this solves.** Without a named pipeline, features skip stages
ad hoc — architecture happens inside PRs, requirements live in chat, design
feedback arrives after implementation — and each artifact is reviewed never or
late. This module codifies the idea→shipped flow: research spike → PRD →
architecture → design-prototype loop → epic decomposition, with adversarial
review and de-scarring at every stage.

**Invariant.** Each stage produces a named artifact from a committed template;
each artifact is adversarially reviewed (fresh context, red-team posture)
before the next stage consumes it; accepted artifacts are de-scarred; design
prototyping is allowed to feed back into requirements and architecture rather
than being a rendering step.

**Port sources**: docomply `docs/development/feature-delivery-pipeline.md`
(C1), `docs/development/templates/{prd,research-doc,architecture}-template.md`
(C3); `seeds/project-kickoff/` phases 1–4 and 10–11 for the greenfield
variant. Ports in Phase 5; PLAYBOOK.md carries the condensed narrative now.

**Status**: stub.
