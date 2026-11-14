# The Jig Protocol

Jig's parts agree on a few closed lists and shapes: the way a drive reports
how it ended, the records Jig writes, the labels and hidden comment markers
it reads, the commands a repository supplies. Programs outside Jig's skills
read them too: a dashboard, a workspace app, a repository's own scripts,
another agent harness. The
[Jig Protocol](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) is
the one statement of each such contract, one chapter per contract, written
for a reader that acts on the values without reading Jig's code.

You can trust a chapter because it is not written by hand where it matters.
Its values, and the meaning of each, are generated from the tables Jig's own
code reads, and Jig's build fails when a chapter and the code disagree. Only
the explanation around them is prose. Each chapter carries its own version
and says whether it is:

- **stable**: within one version it only grows. A value is never removed or
  given another meaning (a withdrawn value stays listed as a tombstone), and
  a field is never removed, retyped or made required. A change that breaks
  this raises the chapter's version, and the release notes say what a reader
  must change.
- **provisional**: it states what the code does in the release that ships
  it, and names the plan items that may still change it.

Each chapter's values are also in a JSON file under [data/](data/), with the
chapter's version, status and a description of each field, for a program in
any language. These files describe the plugin release they ship in.

## Chapters

<!-- protocol:generated source=tools/protocol/chapters.ts#CHAPTERS -->

| Chapter | What it covers | Version | Status | Data file |
| --- | --- | --- | --- | --- |
| [Drive end states and exit codes](drive-exits.md) | How a drive, or one round of it, ended: each state and the exit code `drive-status.ts` and `drive.ts` report it with. | 1 | stable | [data/drive-exits.json](data/drive-exits.json) |

<!-- /protocol:generated -->

How the chapters are generated and checked:
[design/protocol.md](https://github.com/jig-harness/jig/blob/main/design/protocol.md),
and the decision behind it:
[ADR-0020](https://github.com/jig-harness/jig/blob/main/docs/adr/ADR-0020-protocol-chapters-are-generated-and-gated.md).
