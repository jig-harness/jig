# Artifact Checklists

Use these checklists to verify completion of each project kickoff stage.

---

## After Discovery (Phases 1-4)

### Seed Documents Created
- [ ] `seed-PRD.md` exists with:
  - [ ] Problem statement
  - [ ] User personas defined
  - [ ] Functional requirements with examples
  - [ ] Non-functional requirements
  - [ ] Scope boundaries (in/out)
  - [ ] Future enhancements marked post-MVP

- [ ] `seed-ARCHITECTURE.md` exists with:
  - [ ] Stack selection with rationale
  - [ ] External dependencies listed
  - [ ] Environment strategy defined
  - [ ] Scale estimates per phase
  - [ ] Cost projections

- [ ] `seed-critical-analysis.md` exists with:
  - [ ] Executive summary
  - [ ] Requirements critique
  - [ ] Architecture critique
  - [ ] Categorized recommendations (must/should/nice)

### Final Documents Created
- [ ] `PRD.md` (final) addresses all "must address" critiques
- [ ] `ARCHITECTURE.md` (final) addresses scalability/security concerns
- [ ] Neither document mentions or references the critical analysis
- [ ] Scope is clear and achievable for MVP

---

## After Repository Bootstrap (Phases 5-7)

### Repository Structure
- [ ] Git repository initialized
- [ ] `docs/` directory created
- [ ] `docs/PRD.md` placed
- [ ] `docs/ARCHITECTURE.md` placed

### Core Documents
- [ ] `AGENTS.md` exists with:
  - [ ] Product Manager agent defined
  - [ ] Architect agent defined
  - [ ] DevOps Engineer agent defined
  - [ ] Model specified for each agent
  - [ ] Skills referenced for each agent
  - [ ] When-to-use guidance

- [ ] `README.md` exists with:
  - [ ] Project overview
  - [ ] Quick start instructions
  - [ ] Links to documentation
  - [ ] Contributing guidelines

- [ ] `development-guide.md` exists with:
  - [ ] Local setup instructions
  - [ ] Quality gates documentation
  - [ ] Git workflow
  - [ ] Agent usage guide
  - [ ] Skill reference
  - [ ] Environment configuration

### Project Infrastructure
- [ ] Tracking mechanism selected
- [ ] Tracking mechanism configured (if not just markdown)

- [ ] Custom skills created:
  - [ ] At least `architect-review` skill
  - [ ] Skills have SKILL.md with proper frontmatter
  - [ ] Skills validated with `skill_validate`

- [ ] Quality gates configured:
  - [ ] Pre-commit hooks installed (lefthook/husky)
  - [ ] Type checker configured
  - [ ] Linter configured
  - [ ] Test framework configured
  - [ ] Formatter configured

### Master Plan
- [ ] `master-plan.md` exists with:
  - [ ] Phased structure
  - [ ] Trackable milestones
  - [ ] Task checkboxes
  - [ ] Effort estimates
  - [ ] Success criteria per phase

- [ ] Master plan reviewed by Architect (Phase 6):
  - [ ] Sequencing validated
  - [ ] Dependencies correct
  - [ ] Scope realistic
  - [ ] Risks identified

---

## After Implementation Prep (Phases 8-11)

### Project Scaffolding
- [ ] Project scaffolding created
- [ ] Latest stable versions used
- [ ] Dependencies install successfully
- [ ] Dev server runs without errors
- [ ] Basic smoke test passes

### Agent Hierarchy
- [ ] Nested AGENTS.md files created where needed:
  - [ ] Frontend area (if applicable)
  - [ ] Backend area (if applicable)
  - [ ] Shared packages (if applicable)

- [ ] Each nested AGENTS.md has:
  - [ ] Area-specific conventions
  - [ ] Relevant skills listed
  - [ ] Testing patterns

- [ ] Root AGENTS.md updated:
  - [ ] References nested files
  - [ ] Removed specifics now in nested files
  - [ ] Contains orchestration guidance

### Implementation Plans
- [ ] Implementation plan for Phase 1 exists
- [ ] Implementation plan for Phase 2 exists (at minimum outline)
- [ ] Each implementation plan reviewed by Architect:
  - [ ] Technical feasibility confirmed
  - [ ] Sequencing validated
  - [ ] Missing tasks identified
  - [ ] Risks flagged

### Tracking Population
- [ ] Tracking mechanism populated with Phase 1 tasks
- [ ] Each task includes:
  - [ ] Reference to implementation plan
  - [ ] Relevant skills mentioned
  - [ ] Suggested agent
  - [ ] Acceptance criteria

- [ ] First sprint/cycle set up
- [ ] Team ready to begin implementation

---

## Quick Validation Commands

### Skill Validation
```bash
# Validate a skill
python ~/.claude/skills/skill-creator/scripts/validate_skill.py path/to/skill
```

### Quality Gates Check
```bash
# Run all pre-commit hooks
lefthook run pre-commit

# Or if using husky
npx husky run
```

### Project Health
```bash
# TypeScript
pnpm tsc --noEmit

# Tests
pnpm test

# Lint
pnpm lint
```

---

## Red Flags to Address Before Proceeding

### Discovery Phase Red Flags
- Requirements have no concrete examples
- User personas are vague or missing
- Scope boundaries unclear
- Critical analysis identified blocking issues not addressed
- Architecture has single points of failure

### Bootstrap Phase Red Flags
- No quality gates configured
- AGENTS.md missing key personas
- Master plan has no success criteria
- Tracking mechanism not set up
- No architect review of master plan

### Implementation Prep Red Flags
- Scaffolding doesn't run
- No implementation plans for Phase 1
- Implementation plans not reviewed
- Tracking not populated
- Team unclear on first tasks
