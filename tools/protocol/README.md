# Maintaining the Jig Protocol

The [Jig Protocol](../../plugin/protocol/README.md) gives programs a
versioned contract for the values Jig writes and reads. Keep a chapter's
values in the code that uses them and let the generator publish them.
[ADR-0020](../../docs/adr/ADR-0020-protocol-chapters-are-generated-and-gated.md)
defines the policy.

## The chapter template

Each chapter has an entry in [the chapter list](chapters.ts) and a
Markdown file in [plugin/protocol/](../../plugin/protocol/README.md).
The entry names the source table and renderer for each generated section.
In the Markdown file, wrap each such section in
`<!-- protocol:generated source=path#TABLE -->` and
`<!-- /protocol:generated -->`. Write the explanation around those
sections by hand. Keep each value's meaning next to the value in code, and
link from other documents to the chapter for the contract itself.

The generator updates each chapter's title, status and marked sections,
the index table, the JSON data files and the schemas declared by the
chapter. A JSON shape's field description supplies the reader's checks
and the published schema. Schema tests validate records written by Jig
against that schema.

## What stable promises, and how the gate holds it

A provisional chapter names the [open plan items](../../design/plan.md)
that can still change it. When the last one finishes, remove it from the
chapter's list and mark the chapter stable. The gate checks that every
listed item is open and that stable chapters name none.

For a chapter that was stable at the merge base, the gate compares the new
chapter with the integration branch's data at that merge base. A chapter
that becomes stable in this change has no stable baseline to compare yet.
Each value is matched by
its identifying fields, and each field is compared using the base's
`comparedAs` rule. Within one version, additions may widen the contract
and withdrawals leave tombstones. Breaking changes require a higher
chapter version and a [breaking change note](../../changes/README.md)
that identifies the chapter and explains what its readers need to do.
To remove a stable chapter, declare it withdrawn in the chapter list
with a higher version and add a `**Breaking:**` change-note entry that names
the chapter's Markdown filename.

## The generator and its gate

Run `bun tools/protocol/generate.ts` to regenerate the chapters. Run
`bun tools/protocol/generate.ts --check` to check freshness and stability.
If the merge base is unavailable in a shallow checkout, fetch the
integration branch's history before checking.

The [change-area catalog](../../.config/change-areas.yaml) lists the
generator's inputs and outputs. Tests check that the inventory includes
the modules each chapter imports and that each eligible entry in those
sources is rendered or explicitly excluded. The pre-commit hook runs
the generator with `--stage` when a staged change touches its inputs.
`bun run gates` runs the check.

## How the site renders the chapters

The [website build](../../design/website.md#page-types) reads
`plugin/protocol/` for the index and chapter pages. Each chapter page
shows its status, prose and tables with an anchor for each value.
The site serves the current version's JSON and schemas at the
[documented versioned URLs](../../plugin/protocol/README.md#earlier-versions-are-withdrawn).
The site build checks that schema identifiers match the chapter and
version it serves.
