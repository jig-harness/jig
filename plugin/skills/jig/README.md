# jig: finding your way around Jig

An agent working in a repository that uses Jig sees each of the plugin's
skills on its own: one line that says what it does. Nothing says how the
skills hand work to one another, where the plugin's configuration reference
is, or what to do when Jig itself misbehaves. Without that, an agent
rediscovers the map every session, picks a skill by its name alone, and
when Jig has a bug it works around it in the repository or reports it to
the wrong tracker.

`/jig:jig` answers those three questions. It sends the agent to the
reference that ships inside the installed plugin (the skills tables in the
plugin's README, `CONFIGURATION.md`, each skill's own pages), so what it
reads matches the version that runs; and to Jig's repository at that
version's tag for the practice modules and the glossary. It does no work
itself: it names the skill that does.

## Reporting a Jig bug

A Jig bug is an issue on [jig-harness/jig](https://github.com/jig-harness/jig/issues),
labelled `bug`, in the fields of its bug form: plugin version, the channel
it was installed from, the last version it worked in, what happened, what
was expected, and the agent tool and operating system. The skill first
decides whether the fault is Jig's at all (a configuration error, the
repository's own gate, a missing tool and a lesson for
[reflect](../reflect/README.md) each go elsewhere), searches for an issue
that already describes it, and then drafts the report with
`report-bug.ts`, which has these commands: `search` for an existing issue,
`draft` for the report, `file` to file a draft a person confirmed.

```sh
bun "<plugin>/skills/jig/scripts/report-bug.ts" draft --skill "drive-pr" --symptom "parks on a pull request whose checks are green" --what "what-happened.txt" --expected "the drive converges" --channel "stable" --out "draft.json"
```

The script reads the plugin version, the operating system and, inside
Claude Code, the tool's version itself. It replaces the repository's own
names with placeholders (its path, the home directory, the owner and name
in its remote's address, its tracker team's issue keys) and lists what it
replaced, since the report goes to a public tracker. It also prints the bug
form's address with the fields filled in, for a machine without `gh`.

A person confirms every report before it is filed: filing publishes. In an
unattended run the agent stops with the draft instead. In Jig's own
repository, use [file-issue](../file-issue/README.md), which applies Jig's
label taxonomy.

The skill reads no configuration field of its own; the script reads
`repository.remote` and `issue_tracker.team` to know what to replace.
