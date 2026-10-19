---
name: adr
description: "Record a technical decision as a numbered architecture decision record, extract its checkable rules into the decision-rules file, and carry it into the agent instructions; use when a decision is made or a decision record changes."
context: fork
disable-model-invocation: true
allowed-tools: "Read Write Edit Grep Glob Bash(bun *) Bash(git *) Bash(gh *)"
---

# Architecture decision records

Manage architecture decision records ([ADRs](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)) and the
rules extracted from them. Jig's ADR module
([M5](https://github.com/jig-harness/jig/blob/main/modules/M5-adr-practice/README.md)) defines the practice: one
short numbered record per decision, changed only by amendment or supersession,
with every pattern-checkable decision turned into a rule a gate enforces.

### Paths and working directory

`${CLAUDE_SKILL_DIR}` in the commands below stands for the absolute path of the
directory containing this `SKILL.md`. Claude Code fills it in. In any other
harness, replace it with that path yourself before running a command: a shell
would expand the unset variable to an empty string.

Run every command from the root of the repository whose decisions you are
recording. Never `cd` into the skill directory.

### Find the records and the rules file

```bash
bun "${CLAUDE_SKILL_DIR}/scripts/locate.ts"
```

It prints, as JSON, the records directory, the file naming in use
(`ADR-NNNN-<slug>.md` or `NNNN-<slug>.md`), the highest number and the next
one, and the decision-rules file. It reads two optional fields from
`.config/jig.yaml`:

- `adr.directory`: where the records live. Default: the first of `docs/adr`,
  `docs/adrs`, `doc/adr`, `docs/decisions`, `docs/architecture/decisions`,
  `doc/architecture/decisions`, `adr`, `decisions` that exists.
- `adr.rules_file`: the decision-rules catalog. Default: the one tracked file
  named `adr-rules.yaml`, `adr-rules.yml`, `.adr-rules.yaml` or
  `adr-rules/rules.yaml` (or `.yml`), outside test fixtures and templates.

`directory: null` means the repository has no records yet: propose `docs/adr`
and confirm with the user before creating it. `rulesFile: null` means it has no
rules catalog: say so when extracting rules (workflow 2). A non-zero exit means
a configured path does not exist, several rules files match, or `git ls-files`
failed (so the search for a rules file was inconclusive); report the message
and stop.

## Workflows

### 1. Create a new record

**Trigger:** "Create an ADR for [decision]".

1. Take `nextFile` from the locate output, replacing `<slug>` with a short
   kebab-case slug. Picking the next number races with other branches: two
   branches that each add "the next" record collide when both merge. If the
   repository runs a numbering gate (M5's numbering gate), it catches that;
   either way, check that no open pull request already adds the same number.
2. Use the repository's own template when it has one (a template file in the
   records directory, or one named in its docs). Otherwise use this skeleton,
   which matches M5's [template](https://github.com/jig-harness/jig/blob/main/modules/M5-adr-practice/templates/ADR-template.md)
   and the frontmatter M4's schema checks:

   ```markdown
   ---
   title: "ADR-NNNN: <Short decision title>"
   type: adr
   status: draft               # draft -> approved -> amended | deprecated
   description: "<one-line summary of the decision>"
   lifecycle: permanent
   version: "1.0"              # bump on each amendment
   last_updated: YYYY-MM-DD
   owner: <owner from the schema>
   decision_date: YYYY-MM-DD   # the day the decision was made; never changes
   supersedes: ~               # the record this replaces, or ~
   superseded_by: ~            # the record that replaced this, or ~
   related:
     - <path of a related record>
   tags: [adr, <topic>]
   ---

   # ADR-NNNN: <Short decision title>

   **Status:** Draft · **Date:** YYYY-MM-DD · **Deciders:** <who>

   ## Context
   <The problem and the forces at play: facts, not the choice.>

   ## Decision
   <What we decided and why, stated plainly: "We use X.">

   ## Alternatives considered
   - **<Option A>**: <why rejected>.

   ## Consequences
   ### Benefits
   - ...

   ### Costs
   - ...

   ## Implementation
   <How to implement this decision.>

   ## Extraction (decisions-become-checks)
   <Is any part of this decision a pattern a gate can verify? If yes, name
   the rule added to the decision-rules file. If no, say "not mechanically
   checkable".>
   ```

   Follow the naming the repository already uses (the `naming` field), the
   status values of its frontmatter schema, and its owners and tags.

**After creating it:**

1. Extract the checkable rules into the rules file (workflow 2).
2. Carry the decision into the agent instructions (workflow 4).

An approved record is never rewritten silently: it changes by a dated
`## Amendments` entry (bump `version`, set `status: amended`, keep
`decision_date`) or by a new record that supersedes it (M5 § Core pieces).

### 2. Extract rules from a record

**Trigger:** a record is created or updated.

When the repository has no rules file, say so and stop this workflow; suggest
adopting M5's [`adr-rules.yaml`](https://github.com/jig-harness/jig/blob/main/modules/M5-adr-practice/templates/adr-rules.yaml)
and its interpreter, and create one only if the user agrees.

1. Read the record.
2. Identify the enforceable rules:
   - **Pattern-matchable**: a text search can detect a violation.
   - **Semantic**: checking it needs reasoning about context.
3. For each pattern-matchable rule, add an entry to `pattern_rules`. Match the
   shape of the rules already in the file (keep a field such as `tier` if
   they carry one). In M5's shape:

   ```yaml
   - id: PM-NNN
     adr: ADR-XXXX
     name: descriptive-name
     severity: critical
     pattern: 'regex pattern'
     follow_check: 'companion'
     exclude: ['**/*.test.ts']
     message: 'Human-readable violation message (ADR-XXXX)'
     fix_hint: 'How to fix this violation'
   ```

   `severity` is `critical`, `warning` or `info`; `follow_check` is optional
   (the pattern must have a match for it within a few lines).

   M5's interpreter reads this list line by line rather than as YAML, so keep
   each entry in the shape above: open it with `- id:`, write each value on
   its field's own line (no `|` or `>` block scalars, `exclude` as a one-line
   `[...]` list), and put no `# comment` after a value: the interpreter keeps
   it as part of the value. Write patterns unquoted or in single quotes so the
   text is the regular expression as written: double quotes invite YAML
   backslash-escaping mistakes.
4. For each semantic rule: if the file has a `semantic_rules` list (read by a
   review harness such as `/jig:review`), add it there, in the shape of
   the entries already present, typically:

   ```yaml
   - id: SEM-NNN
     adr: ADR-XXXX
     name: descriptive-name
     severity: critical
     trigger: 'when this rule applies'
     prompt: |
       What the reviewer must verify
     message: 'Human-readable message (ADR-XXXX)'
   ```

   A file without that list keeps to the pattern-checkable subset (M5); then
   record the semantic rule in the record's Extraction section only.
5. If the file keeps an `adr_summaries` map, add a one-line summary of the
   core decision:

   ```yaml
   adr_summaries:
     ADR-XXXX: "One-line summary of the core decision"
   ```

6. **Validate after every change to the rules file:**

   ```bash
   bun "${CLAUDE_SKILL_DIR}/scripts/validate-rules.ts" <rules-file>
   ```

   It checks that the file parses (a duplicated key is an error), that every
   rule has an id and no id appears twice, that every pattern rule has a
   pattern, that every `severity` is `critical`, `warning` or `info`, that
   every `pattern`, `follow_check` and `exclude` glob compiles, and that M5's line-by-line
   interpreter reads every `pattern_rules` entry the same as the YAML does.
   Exit 1 lists the problems; fix them and run it again. Exit 2 means the file
   could not be read or parsed.

### 3. Report rule coverage

**Trigger:** "Check ADR compliance" or "What ADR rules exist?"

1. Read the rules file (the validate command above prints the count of each
   rule list).
2. Report:
   - the number of pattern rules;
   - the number of semantic rules;
   - the rules per record (their `adr` field);
   - the records without any rule (compare with the records directory),
     each with its Extraction verdict when it has one.

### 4. Carry the decision into the agent instructions

**Trigger:** a record is created or updated.

1. Find the instruction files the decision affects:
   - the root instruction file (`AGENTS.md` or its equivalent) for
     repository-wide decisions;
   - the nested instruction file of an affected package or application for
     decisions local to it;
   - a tool-specific file (`CLAUDE.md`, for example) only for a decision about
     that tool.
2. Update them, or run the repository's own skill for updating agent
   instructions if it has one. Link to the record rather than restating it,
   so the decision has one home.

## Example: clock injection

**The record says:** "`new Date()` is forbidden in production code; inject a
clock."

**Extracted rule:**

```yaml
- id: PM-002
  adr: ADR-0017
  name: no-new-date
  severity: critical
  pattern: 'new\s+Date\(\)'
  exclude: ['**/*.test.ts', '**/clock.ts']
  message: 'Use the injected clock instead of new Date() (ADR-0017)'
  fix_hint: 'Inject the Clock and call clock.now()'
```

## Files

| File | Purpose |
|------|---------|
| `<records directory>/ADR-*.md` (or `NNNN-*.md`) | The decision records |
| The rules file (`adr-rules.yaml` or as configured) | Machine-readable rules extracted from the records |

## Integration

- **`/jig:review`** reads the rules file when it checks a change
  against the recorded decisions: pattern rules mechanically, semantic rules
  by reasoning.
- **Continuous integration** can run the pattern rules on every change with
  M5's interpreter (`adr-rules-check.ts`), and the numbering gate beside it.
