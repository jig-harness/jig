# Documentation Standards

Quick reference for project documentation standards enforced by the `/documentation-manager` skill.

## Frontmatter Standard

All documentation files MUST have YAML frontmatter:

```yaml
---
title: Human-Readable Document Title
type: PRD|ARCHITECTURE|PLAN|GUIDE|REFERENCE|RUNBOOK|API|DESIGN
lifecycle: draft|review|permanent|temporary|archived
owner: Agent name, person, or team
created: YYYY-MM-DD
updated: YYYY-MM-DD
version: X.Y.Z
tags: [comma, separated, tags]
---
```

## Document Types & Locations

| Type | Purpose | Lifecycle | Naming | Location |
|------|---------|-----------|--------|----------|
| PRD | Product Requirements | permanent | PRD.md | /docs |
| ARCHITECTURE | Technical Architecture | permanent | ARCHITECTURE.md | /docs |
| PLAN | Implementation plans | temporary | plan-name.md | /docs/plans |
| GUIDE | How-to guides | permanent | guide-name.md | /docs/guides |
| REFERENCE | Reference docs | permanent | reference-name.md | /docs/references |
| RUNBOOK | Operational procedures | permanent | runbook-name.md | /docs/runbooks |
| API | API documentation | permanent | api-reference.md | /docs/api |
| DESIGN | Design documents | permanent | design-name.md | /docs/designs |

## Lifecycle States

| State | Meaning | When to Use |
|-------|---------|-------------|
| draft | Work in progress | Initial creation, major revisions |
| review | Under review | Ready for team feedback |
| permanent | Stable, maintained | Approved, authoritative |
| temporary | Short-lived | Plans, spikes, experiments |
| archived | Historical reference | Replaced or obsolete |

## Naming Conventions

**Main documents** (UPPERCASE):
- PRD.md
- ARCHITECTURE.md
- README.md
- CHANGELOG.md
- CONTRIBUTING.md

**All others** (lowercase-with-hyphens):
- deployment-guide.md
- api-reference.md
- testing-strategy.md

**Invalid**:
- ❌ DeploymentGuide.md (PascalCase)
- ❌ deployment_guide.md (snake_case)
- ❌ Deployment Guide.md (spaces)

## Required Documentation (Context-Dependent)

### Universal (All Projects)
- README.md
- CONTRIBUTING.md
- CHANGELOG.md
- docs/PRD.md
- docs/ARCHITECTURE.md

### Web Applications
- docs/guides/deployment-guide.md
- docs/guides/build-guide.md
- docs/guides/environment-setup.md

### API Services
- docs/api/api-reference.md
- docs/api/authentication.md
- docs/api/rate-limits.md

### With CI/CD
- docs/guides/pipeline-guide.md
- docs/guides/pr-process.md

### Security-Critical
- docs/guides/security-guide.md
- docs/runbooks/security-incident.md

Use `/documentation-manager` to validate compliance and generate missing documentation checklists.
