# Design brief preparation and handback

Each external design round can start from an older copy of the prototype.
The [design handback](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md#design-handback) command preserves repository fixes with a three-way merge and
makes regressions visible before a returned bundle is accepted.

Run scripts from the consumer repository root with Bun. `<skill-dir>` is the
installed directory containing this page; it works without plugin dependencies.

## Configure the landing check

Set `design_brief.handback` through Jig's configuration layers:

```yaml
design_brief:
  handback:
    forbidden_terms: [Retired Example]
    widths: [390, 1280]
    rubric: design/rubric.md
    scorecard: design/scorecard.md
    browser_executable: /path/to/chromium
```

Only `forbidden_terms` defaults (to empty). All other fields are required.
The browser must be an installed Chromium-compatible executable supporting
Chrome's debugging protocol. The runner uses Bun's built-in networking APIs
and starts a separate headless profile. No plugin package installation is needed.

Each bundle has a `README.md` and `design-handback.json`:

```json
{
  "version": 1,
  "prototype": "index.html",
  "scenarios": [
    {"name": "empty", "url": "index.html?scenario=empty", "screenshot": "screenshots/empty.png"},
    {"name": "populated", "url": "index.html?scenario=populated", "screenshot": "screenshots/populated.png"}
  ]
}
```

Use the bundle's actual scenario names and URLs. The delivered screenshot path
is for the first configured width; later widths append `-<width>` before the
extension. Both README and scorecard state `Bar outcome: pass` after the rubric
review passes. README may extend the configured terms with a comma-separated
`Forbidden terms: ...` line; that declaration itself is excluded from scanning.

## Land one returned round

1. Save the current landed commit with `git rev-parse HEAD`. Replace the bundle
   at its canonical repository path with the untouched raw delivery and commit
   it. This raw commit stays in branch history, preserving the next round's base.
   Land the bundle with a merge that preserves this commit. Squashing or
   rewriting it removes the recorded base from the final branch's history;
   the landing check refuses a raw export that is not an ancestor of `HEAD`.
2. Merge into a new scratch directory (the output must not already exist):

   ```sh
   bun "<skill-dir>/scripts/handback.ts" merge design/prototypes/flow HEAD /tmp/flow-merged --ours "<saved-landed-commit>"
   ```

   The recorded [export base](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md#export-base), `Export base: <commit>`, in the saved README supplies the base.
   Without it the first commit adding the bundle supplies the base, and the
   report and README explicitly say `first-added fallback`.
3. Copy the staged result into the canonical bundle path and immediately run
   `bun "<skill-dir>/scripts/handback.ts" check design/prototypes/flow` before
   manual review. The initial failure lists forbidden text, external request
   attempts and other mechanical findings alongside the merge report. Resolve
   the files in that canonical directory. The JSON report lists conflicts and every
   repository-change hunk whose replacement and neighboring lines no longer
   match the merged file at their expected position. This conservative check
   can require review when unrelated earlier lines move. It does not mistake
   repeated text elsewhere for a surviving fix. For each conflict resolve the
   file and remove its entry from `conflicts`; for each regression restore the
   fix or decide to accept it, then set its `acknowledged` to `true`.
4. Keep `handback-report.json`
   and the generated README's export-base metadata. Supply fresh delivered
   screenshots at every configured width, with modification times strictly
   newer than the prototype. Git snapshots do not preserve delivery modification
   times: capture the delivered screenshots after resolving the merge. Existing scenario screenshots must differ from
   those in the saved landed commit. New scenario paths have no prior image.
5. Run the mechanical landing check, then commit the accepted fixes:

   ```sh
   bun "<skill-dir>/scripts/handback.ts" check design/prototypes/flow
   ```

The checker rejects forbidden text in files and rendered scenario text, conflict markers and unreviewed report
entries, missing review evidence or a failing bar, nested `uploads/uploads/`,
hash-suffixed uploads, stale screenshots, external requests, browser errors and
horizontal overflow. It renders every scenario at every configured width.
Verification images go to `.handback-render/`; delivered screenshot evidence is preserved.
Unsupported embedded frames or workers fail closed. Browser requests use only
the bundle's temporary local server; external request attempts are failures.

Exit 0 means the command passed. Exit 1 means findings need resolution; merge
still writes the scratch result for review. Exit 2 means the command could not
check, including missing configuration, malformed data or unavailable browser.
A first bundle needs an initial raw commit and the same merge path: use that
commit as `--ours`; the explicit fallback records its initial base.

## Derive brief facts

A consumer command prints a nonempty JSON object of named facts from its
sources. Generate the Markdown table instead of counting entities by hand:

```sh
bun "<skill-dir>/scripts/handback.ts" facts '["bun","scripts/export-design-facts.ts"]' /tmp/data-facts.md
```

The generated file records the exact argument array, UTC generation timestamp
and SHA-256 digest of source output. Include it in `uploads/reference-specs/`
and cite it from the brief. The command executes directly as an argument array;
it does not invoke a shell.
