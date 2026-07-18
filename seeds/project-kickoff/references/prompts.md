# Prompt Templates

Ready-to-use prompts for each phase of the project kickoff methodology.

---

## Requirements Discovery

Use in Phase 1 to initiate interactive requirements gathering.

```
I want to define requirements for [PROJECT_NAME]. Let's have an iterative
conversation where you ask qualifying questions to help me clarify the scope.

Start by understanding:
- Who are the users?
- What problem are we solving?
- What does success look like?

Focus on:
- User personas and their goals
- Core functionality with concrete examples
- Scope boundaries (what's in, what's out)
- Future enhancements (mark as post-MVP)

Ask me questions one topic at a time. Don't assume—probe for specifics.
Keep technical implementation out of scope for now.

When we've covered enough ground, synthesize our discussion into a seed-PRD.md
document with these sections:
- Problem Statement
- User Personas
- Functional Requirements (with examples)
- Non-Functional Requirements
- Scope (In/Out)
- Future Enhancements (Post-MVP)
```

---

## Technical Architecture

Use in Phase 2 after requirements are defined.

```
Based on the requirements we've defined, let's design the technical architecture.

Please propose:

1. **Stack Selection**
   - Frontend framework and rationale
   - Backend framework and rationale
   - Database choice and rationale
   - Infrastructure approach

2. **External Dependencies**
   - Third-party services we'll need
   - APIs to integrate
   - Subscriptions/tools to consider

3. **Environment Strategy**
   - Development setup
   - Staging environment
   - Production infrastructure

4. **Scale Estimates**
   - Phase 1 (MVP): expected users, requests/day
   - Phase 2 (Growth): projections
   - Phase 3 (Scale): targets

5. **Cost Projections**
   - Per-phase estimates for infrastructure and services

Present alternatives where trade-offs exist. Ask clarifying questions if you
need more information about constraints (budget, team size, timeline, etc.)
```

---

## Critical CTO

Use in Phase 3 with a NEW SESSION. Provide seed-PRD.md and seed-ARCHITECTURE.md.

```
I want you to act as a Critical CTO reviewing a project proposal. Your job is to:

1. **Attack the idea**: Find weaknesses, risks, and potential failures
2. **Challenge assumptions**: What are we taking for granted that might be wrong?
3. **Identify gaps**: What's missing from the requirements or architecture?
4. **Stress test the architecture**: Where will it break under load? What are the
   single points of failure?
5. **Question the scope**: Is the MVP too ambitious? Too narrow?
6. **Suggest improvements**: For each criticism, propose a mitigation or alternative

Be harsh but constructive. I'd rather find problems now than in production.

Structure your response as:
- Executive Summary (1-2 paragraphs, harsh but fair)
- Requirements Critique (gaps, ambiguities, scope concerns)
- Architecture Critique (technical risks, scalability, security, cost)
- Recommendations (must address, should consider, nice to have)
- Alternative Approaches (if applicable)

Here are the documents to review:

---
[PASTE seed-PRD.md HERE]
---

---
[PASTE seed-ARCHITECTURE.md HERE]
---
```

---

## Document Synthesis

Use in Phase 4 with a NEW SESSION. Provide all three seed documents.

```
I have three documents from a project planning process:
1. Initial PRD (requirements)
2. Initial Architecture
3. Critical analysis with identified issues and recommendations

Please synthesize these into final PRD.md and ARCHITECTURE.md documents that:
- Incorporate valid criticisms and recommendations
- Resolve identified gaps and ambiguities
- Strengthen weak areas
- Do NOT mention or reference the critical analysis
- Present as polished, standalone documents ready for implementation

The final documents should read as if they were created by a thoughtful team
that considered all angles from the start.

---
SEED PRD:
[PASTE seed-PRD.md HERE]
---

---
SEED ARCHITECTURE:
[PASTE seed-ARCHITECTURE.md HERE]
---

---
CRITICAL ANALYSIS:
[PASTE seed-critical-analysis.md HERE]
---
```

---

## Architect Review

Use in Phase 6 (master plan review) and Phase 10 (implementation plan review).

```
As a Senior Architect, review this [DOCUMENT_TYPE] for:

1. **Technical Feasibility**
   - Are all tasks achievable with the proposed stack?
   - Are there hidden complexities not accounted for?

2. **Sequencing & Dependencies**
   - Is the order of tasks correct?
   - Are prerequisites properly identified?
   - Will any task block others unexpectedly?

3. **Completeness**
   - What tasks are missing?
   - Are edge cases and error handling covered?
   - Is testing adequately planned?

4. **Risk Areas**
   - Which tasks have the highest risk?
   - What could go wrong?
   - What mitigations should be in place?

5. **Simplification Opportunities**
   - Can anything be removed or deferred?
   - Are we over-engineering any component?
   - What's the minimal viable approach?

Provide specific, actionable feedback. Flag any items that should block
proceeding until resolved.

---
[PASTE DOCUMENT HERE]
---
```

---

## Master Plan Creation

Use in Phase 5.7 to structure the master plan.

```
Based on the PRD and Architecture documents, create a master-plan.md with:

1. **Phased Structure**
   - Phase 1: Foundation/MVP (what's needed to validate the core idea)
   - Phase 2: [Next logical milestone]
   - Phase 3+: [Future phases]

2. **For Each Phase**
   - Clear milestone definitions
   - Trackable tasks with checkboxes
   - Dependencies between tasks
   - Estimated effort per task (S/M/L/XL)

3. **Success Criteria**
   - What defines "done" for each phase?
   - What metrics indicate success?

Structure as markdown with checkboxes that can be tracked:

```markdown
# Master Plan

## Phase 1: Foundation (MVP)
**Goal**: [One sentence]
**Success Criteria**: [Measurable outcomes]

### Milestone 1.1: [Name]
- [ ] Task (Size: S) - Description
- [ ] Task (Size: M) - Description

### Milestone 1.2: [Name]
...
```

Focus on Phase 1 and 2 in detail. Phase 3+ can be higher-level.
```

---

## Implementation Plan Creation

Use in Phase 10 for detailed phase breakdowns.

```
Create a detailed implementation plan for [PHASE_NAME] from the master plan.

For each milestone and task:

1. **Epic Breakdown**
   - Split major features into epics
   - Define epic scope and acceptance criteria

2. **Task Details**
   - Specific implementation steps
   - Files/components to create or modify
   - Test requirements
   - Dependencies (what must be done first)

3. **Agent Assignment**
   - Which stereotyped agent should handle each task?
   - Which skills are relevant?

4. **Effort Estimates**
   - S: 1-2 hours
   - M: 2-4 hours
   - L: 4-8 hours
   - XL: >8 hours (should be broken down further)

5. **Risk Flags**
   - Mark any tasks with technical uncertainty
   - Note tasks requiring research spikes

Output as: `docs/plans/phase-N-implementation.md`
```

---

## Agent Definition

Use in Phase 5.2 to define stereotyped agents in AGENTS.md.

```
Define the stereotyped agents for this project. For each agent, specify:

1. **Role**: What is this agent responsible for?
2. **Expertise**: What domains and technologies does it know?
3. **Model**: Which Claude model should be used? (Opus/Sonnet/Haiku)
4. **Skills**: Which project skills should this agent invoke?
5. **When to Spawn**: Under what circumstances should this agent be used?
6. **Handoff Protocol**: How does it communicate with other agents?

Minimum agents:
- Product Manager
- Architect
- DevOps Engineer

Consider adding based on project needs:
- Backend Engineer
- Frontend Engineer
- QA/Tester
- Security Reviewer
- Technical Writer
- Database Specialist
```

---

## Development Guide Creation

Use in Phase 7 to create developer documentation.

```
Create a development-guide.md for human developers joining this project.

Include these sections:

1. **Local Setup**
   - Prerequisites (versions of Node, Python, etc.)
   - Clone and install steps
   - Environment variable configuration
   - Database setup (if applicable)
   - Running the dev server

2. **Quality Gates**
   - Pre-commit hooks and what they check
   - How to run linting manually
   - How to run tests
   - CI pipeline overview

3. **Git Workflow**
   - Branch naming: feature/, fix/, chore/
   - Commit message format
   - PR creation process
   - Review requirements before merge

4. **Agent Usage**
   - Available stereotyped agents
   - When to use each agent
   - How to invoke skills
   - Multi-agent coordination

5. **Project Skills**
   - List of available skills
   - Brief description of each
   - When to use them

6. **Environment Configuration**
   - Required environment variables
   - Secrets management approach
   - Dev vs staging vs production differences

Keep it practical and scannable. Developers should be productive within 30 minutes.
```
