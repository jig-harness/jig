# red-team

**What problem this solves.** A requirements or architecture document is
usually reviewed by the people who wrote it, or by an agent that helped
write it, and both defend what is already there. The gaps surface later, in
a pull request or in production, where they cost the most to fix. Without a
deliberate adversarial pass, nobody reads the document as a security
auditor, as the person paying the bill, or as a user who knows no
engineering terms, and the questions those readers would ask stay unasked.

`/jig:red-team <document>` runs a [red-team review](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) of
one requirements document ([PRD](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md)) or architecture
document: several [review personas](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) each read it in
fresh context, from one point of view, and report what is wrong, missing or
unclear. The result is one report with a verdict per persona and, for every
finding, the passage it concerns, the risk and the question the author must
answer. It never edits the document.

It is the runnable form of the per-stage adversarial review in
[M6](https://github.com/jig-harness/jig/blob/main/modules/M6-feature-delivery-pipeline/README.md), for the
requirements and architecture stages. The agent's procedure is in
[SKILL.md](SKILL.md).

## The personas

| Persona | Reads | Stands for |
|---------|-------|------------|
| Critical chief technology officer | requirements and architecture | whoever answers for whether this should be built, and built this way |
| Security auditor | requirements and architecture | whoever is accountable when data leaks or an account is taken over |
| Performance engineer | requirements and architecture | whoever is woken when it is slow or falls over |
| Cost optimizer | requirements and architecture | whoever pays the bill, in money and people's time |
| Plain-language reader | requirements | the sponsors, customers and support staff who know no engineering terms |
| Scope cutter | requirements | whoever wants the outcome in users' hands soonest, in the smallest release that delivers it |
| Acceptance tester | requirements | whoever must prove each outcome is done |
| Day-in-the-life walker | requirements | the user, walking a real day with the product, naming the moments the document leaves out |

What each one looks for and what its findings must carry is in
[references/personas.md](references/personas.md), which is also what each
persona is handed. Change the personas there.

## How it runs

1. **Plan.** The plan step reads the document's kind from its
   frontmatter `type:` or from M6's template headings (`--kind` overrides),
   picks the personas and writes a brief for each.
2. **Read, in fresh context.** Each persona runs as a subagent where the
   agent tool has them; otherwise as a fresh, non-interactive run of the
   agent command (`claude -p`, `codex exec`), which the script's fresh
   step starts; otherwise in the same session, one at a time, and the report
   says those personas did not run in fresh context. The collect step
   checks each persona's findings, including that every quoted passage is
   in the document word for word.
3. **Report.** The report step writes the one report.

The steps refuse to go on when the document, or its companion, changes during the review.

## Where the report goes

Into `.context/red-team/<document>-<hash>/report.md`, scratch that git ignores
where `.context/` is ignored (`--out` names another folder). The findings
are review history: under M6 and
[M4](https://github.com/jig-harness/jig/blob/main/modules/M4-docs-governance/README.md), an accepted document
carries the answers, not the critique, so the report is not committed beside
it. Attach it to the pull request or issue that carries the document; the
document's stage-review record (its `reviewed:` key) then links there. The
report's last section gives that line.

## Configuration

None: nothing to set in `.config/jig.yaml`.

## Works with

- [review](../review/SKILL.md) reviews code, diffs and plans; this skill
  reviews the requirements and architecture before them.
- [descar](../descar/SKILL.md) removes review traces from the revised
  document before it is accepted.
- [decide](../decide/SKILL.md) settles a dilemma a finding raises.
