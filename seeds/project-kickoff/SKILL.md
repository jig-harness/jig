---
name: project-kickoff
description: Structured methodology for bootstrapping mid-to-large AI-assisted software projects. Use when starting a new project, defining requirements, planning architecture, or setting up a repository with agents and skills. Triggers on "new project", "project kickoff", "start project", "bootstrap project", or "project methodology".
model: opus
context: fork
---

# Project Kickoff Methodology v2.0

A structured 11-phase process for launching AI-assisted software projects with modular skills, standardized templates, and comprehensive automation.

**What's New in v2.0**:
- Modular skills for critical analysis, plan review, dependency management, and documentation
- IEEE 830-style requirement IDs for traceability
- Comprehensive templates with pipeline automation
- Enhanced tracking options including DartAI

## Quick Start

**Starting fresh?** Begin with Phase 1: Requirements Discovery.
**Have requirements?** Jump to Phase 2: Technical Architecture.
**Have both seed docs?** Proceed to Phase 3: Critical Analysis.

## Phase Overview

| Phase | Name | Model | Skill | Output |
|-------|------|-------|-------|--------|
| 1 | Requirements Discovery | Opus | - | seed-PRD.md |
| 2 | Technical Architecture | Opus | - | seed-ARCHITECTURE.md |
| 3 | Critical Analysis (Red Team) | Opus (new session) | `/critical-analysis` | seed-critical-analysis.md |
| 4 | Document Synthesis | Opus (new session) | Templates | PRD.md, ARCHITECTURE.md |
| - | **Context Transition** | - | - | Switch to Claude Code in repo |
| 5 | Repository Bootstrap | Sonnet/Opus | `/skill-creator` | Git repo + infrastructure |
| 6 | Master Plan Review | Opus | `/plan-reviewer` | Reviewed master-plan.md |
| 7 | Developer Documentation | Sonnet | `/documentation-manager` | development-guide.md |
| 8 | Project Scaffolding | Sonnet | - | Working project structure |
| 9 | Agent Hierarchy | Sonnet | - | Nested AGENTS.md files |
| 10 | Implementation Planning | Sonnet + Opus | `/plan-reviewer` | Phase implementation plans |
| 11 | Tracking Population | Sonnet | - | Populated tracking system |

## Core Principles

1. **Separation of Concerns**: Keep functional requirements separate from technical stack
2. **Context Isolation**: Use new sessions for critical analysis and synthesis (prevents confirmation bias)
3. **Iterative Refinement**: Agents ask qualifying questions; requirements emerge through dialogue
4. **Model-Appropriate Tasks**: Opus for decisions, Sonnet for execution, Haiku for exploration

## Phase Navigation

### Discovery Phases (1-4)
For each phase, see [methodology.md](references/methodology.md) for detailed process.

- **Phase 1**: Interactive requirements dialogue. See [prompts.md](references/prompts.md#requirements-discovery)
- **Phase 2**: Technical stack and cost estimation
- **Phase 3**: ⚠️ NEW SESSION - Invoke `/critical-analysis` skill with Critical CTO persona
- **Phase 4**: ⚠️ NEW SESSION - Use templates (PRD, ARCHITECTURE) and synthesize without mentioning critique
- **Context Transition**: After Phase 4, switch to Claude Code in the repository directory

### Bootstrap Phases (5-7)
Switch to Claude Code in the repository.

- **Phase 5**: Init repo, create AGENTS.md, README.md, skills, quality gates, master-plan.md
- **Phase 6**: Invoke `/plan-reviewer` skill to validate master plan
- **Phase 7**: Create development-guide.md for human developers

### Implementation Phases (8-11)
Continue in Claude Code.

- **Phase 8**: Scaffold project (e.g., `pnpm create next-app@latest`)
- **Phase 9**: Create nested AGENTS.md, update root with references
- **Phase 10**: Create implementation plans + ⚠️ Review each plan with `/plan-reviewer`
- **Phase 11**: Populate tracking mechanism from master-plan

## Stereotyped Agents (Minimum Set)

| Agent | Role | Model |
|-------|------|-------|
| Product Manager | Requirements, prioritization, user stories | Opus |
| Architect | System design, technical decisions, plan review | Opus |
| DevOps Engineer | CI/CD, infrastructure, deployment | Sonnet |

Common additions: Backend Engineer, Frontend Engineer, QA/Tester, Security Reviewer

## Tracking Mechanism Selection

| Tool | Best For | Free Tier |
|------|----------|-----------|
| **DartAI** | Solo/small teams, AI-native planning | Generous |
| Linear | Team projects, structured sprints | Limited |
| Beads | Persistent agent memory (use alongside others) | Yes |
| taskmaster | AI-native task management | Yes |
| trackable-plan.md | Simplest, version-controlled | Yes |

**Recommendation**: DartAI or taskmaster for AI-assisted projects; Linear for teams

## Resources

- **Full methodology**: [references/methodology.md](references/methodology.md)
- **Prompt templates**: [references/prompts.md](references/prompts.md)
- **Artifact checklists**: [references/checklists.md](references/checklists.md)
- **PRD template**: [references/template-prd.md](references/template-prd.md)
- **ARCHITECTURE template**: [references/template-architecture.md](references/template-architecture.md)
- **Documentation standards**: [references/documentation-standards.md](references/documentation-standards.md)

## Related Skills

**Required Dependencies**:
- `/skill-creator` - Create project-specific skills (Phase 5.4)
- `/critical-analysis` - Red team document analysis (Phase 3)
- `/plan-reviewer` - Architect-level plan validation (Phases 6, 10)

**Recommended**:
- `/documentation-manager` - Enforce documentation standards (Phase 7, ongoing)
- `/dependency-upgrader` - Maintain dependencies (Phase 5.6, monthly)
