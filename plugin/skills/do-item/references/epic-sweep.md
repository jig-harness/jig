# Sweep open epics

Use this procedure on demand when coordinating the closure of open epics. The
tracker supplies the live issue type, states and children. The coordinator
supplies the evidence about the scope because a tracker state cannot say
whether a plan entry still describes work the epic was meant to deliver.

Run the commands from the repository root. `<skill-dir>` is the directory of
the `do-item` skill (`${CLAUDE_SKILL_DIR}` in `SKILL.md`); a reference page is
never substituted, so replace it with that path yourself. The commands use the configured tracker adapter and its credentials.
Use an identity that can read the issues for a proposal and can comment,
move children and close epics in the configured repository for acceptance.

## Prepare and propose

Prepare one scope assessment per epic in a JSON file. Name the headings as
they appear in the committed plan and roadmap, without the Markdown heading
prefix. Use a path relative to the repository root. Use `null` only for an
epic with no corresponding entry. An empty `remainder` means the assessed
scope leaves no work for the backlog.

```json
{
  "scopes": [
    {
      "epic": "#123",
      "plan": {"path": "design/plan.md", "heading": "Batch export"},
      "roadmap": null,
      "remainder": [{"title": "Export saved filter presets"}]
    }
  ]
}
```

```sh
bun "<skill-dir>/scripts/epic-sweep.ts" --propose --input scope.json
```

Save the command's JSON output as `proposal.json`. It lists the shipped
children, tails and remaining ordinary scope
alongside the plan references and proposed outcome. An ordinary open child
keeps the epic open, with the next child named. An epic without an
assessment needs one before it can be accepted. An epic carrying
`manual-ops` or in a distinct `ops_pending` state needs an
`Operator Checklist` on the epic before acceptance.
A proposed backlog remainder stays visible in the proposal. The proposal command makes no
tracker writes.

Present the proposal in a comment on a tracker issue in the configured
repository. Put the proposal's `marker` on the last line. A person with
tracker write authority replies on the same issue with `accept all` or
`all except #123, #456`, using the tracker's own issue keys for exclusions.
The sweep matches the reply to the most recent preceding proposal marker
posted by a trusted tracker writer. Keep the original proposal JSON and
the link to the reply.

## Verify and accept

The pull request that delivers an epic's designed scope removes its plan
entry and its roadmap entry wherever listed. Keep those references in the
assessment so the command can check that the headings have left the
integration branch. File any proposed remainder as backlog issues with native related links to
the epic. Set `issue` on each corresponding remainder entry in the scope file
to the new issue's key. Keep the proposed titles and references intact.

```sh
bun "<skill-dir>/scripts/epic-sweep.ts" --accept --input scope.json --proposal proposal.json --reply "<tracker reply URL>"
```

The command checks the original proposal and the person's reply, rereads the
epics and their children, and checks that the plan and roadmap headings have
left the integration branch and that the remainder is represented by linked
backlog issues. A rejecting verdict blocks closure. For accepted epics that
meet these conditions, the command links and comments on the tails,
transfers them, then records the waiver with the reply link before closing
the epic. If the epic itself owes operator steps, the command records those
on the standing list before closing the epic.

Set `issue_tracker.person_checks` to the key of the standing open
[person-checks list](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md).
If an accepted epic needs to transfer a person check and the setting is
missing, the command refuses the transfer and names the setting.
