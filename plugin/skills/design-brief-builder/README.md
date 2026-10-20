# Design brief preparation and handback

Each external design round can start from an older copy of the prototype.
The [design handback](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md) command preserves repository fixes with a three-way merge and
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

Only `forbidden_terms` defaults (to empty). All other fields are required:
`widths` lists distinct positive integers.
The browser must be an installed Chromium-compatible executable supporting
Chrome's debugging protocol. The runner uses Bun's built-in networking APIs
and starts a separate headless profile. No plugin package installation is needed.

Each bundle has a `README.md` and `design-handback.json`:

```json
{
  "version": 1,
  "scenarios": [
    {"name": "empty", "url": "index.html?scenario=empty", "ready": "[data-scenario-ready]", "screenshot": "screenshots/empty.png"},
    {"name": "populated", "url": "index.html?scenario=populated", "ready": "[data-scenario-ready]", "screenshot": "screenshots/populated.png"}
  ]
}
```

Use the bundle's actual scenario names and URLs. `ready` is a CSS selector
that matches only once the scenario has finished rendering; the check waits for
it, within a bounded time, before inspecting the page, and a scenario that never
matches fails. Scenario names must stay distinct once characters other than
letters, digits, `_` and `-` become `_`. The delivered screenshot path
is for the first configured width; later widths append `-<width>` before the
extension, and no two scenario/width pairs may resolve to the same file. A screenshot path is relative to the bundle, `/`-separated, with no
empty, `.` or `..` segment, and never under `.handback-render/`. Paths and
scenario names are compared ignoring case and Unicode normalization, as
Windows and macOS file systems do by default: `HOME.png` and `home.png` are the
same file, and `.HANDBACK-RENDER/` is the renderer's directory. A bundle, on
disk, in a commit the check compares, or as the merge would write it, is
refused when two of its paths, or any of their parent directories, differ only
that way, or when one such name is both a file and a directory
(`assets` beside `ASSETS/a.js`), since a case-sensitive file system would keep
both. After the rubric
review passes, README and the scorecard each state exactly one
`Bar outcome: pass` outside comments and fenced examples, and the scorecard
names the round it reviewed with exactly one
`Reviewed export base: <raw-export-commit>` there. README may extend the configured terms with comma-separated
`Forbidden terms: ...` lines outside comments and fenced examples; every such
line counts, and the declarations themselves are excluded from scanning. A
declaration line counts by its label alone: anything after the colon is its
value, so `Bar outcome: fail (two blockers)` is a second, failing outcome.

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

   The recorded [export base](https://github.com/jig-harness/jig/blob/main/GLOSSARY.md), `Export base: <commit>`, in the saved README supplies the base.
   Without it the first commit adding the bundle supplies the base, and the
   report and README explicitly say `first-added fallback`.
3. Replace the canonical bundle directory with the staged result (remove it,
   then copy the staged directory in), so files the merge deleted do not
   survive from the raw delivery, and immediately run
   `bun "<skill-dir>/scripts/handback.ts" check design/prototypes/flow` before
   manual review. The initial failure lists forbidden text, external request
   attempts and other mechanical findings alongside the merge report. Resolve
   the files in that canonical directory. The JSON report lists conflicts and every
   repository-change hunk whose replacement and neighboring lines no longer
   match the merged file at their expected position. The landing check
   recomputes those hunks against the files as they stand, so a fix lost by a
   later edit is reported too. This conservative check
   can require review when unrelated earlier lines move. It does not mistake
   repeated text elsewhere for a surviving fix. For each conflict resolve the
   file and remove its entry from `conflicts`; for each regression restore the
   fix or decide to accept it, then set its `acknowledged` to `true`. A lost
   hunk the landing check finds that the report does not list yet is accepted
   the same way: add `{"file": "<file>", "hunk": "<hunk>", "acknowledged": true}`
   to `regressions`, copying the file and hunk from the failure line
   `review lost repository hunk: <file>: <hunk>`. A file that is binary on any
   side reports the hunk `binary content differs from the repository version`
   when it differs from the repository's changed version.
4. Keep `handback-report.json`
   and the generated README's export-base metadata. Supply fresh delivered
   screenshots at every configured width, as valid non-interlaced `.png` images
   of at most 256 MiB of decoded image data and at most 67,108,864
   (64 × 1024 × 1024) pixels, with modification
   times strictly newer than every other bundle file except README and the
   report. Git snapshots do not preserve delivery modification
   times: capture the delivered screenshots after resolving the merge. Existing scenario screenshots must differ, as
   images, from those in the saved landed commit: pixels are compared as
   colors and transparency, whatever the color type, bit depth or compression.
   New scenario paths have no prior image. Browser screenshots are
   non-interlaced; re-save an interlaced export without interlacing (for
   example `magick in.png -interlace none out.png`).
5. Run the mechanical landing check, then commit the accepted fixes:

   ```sh
   bun "<skill-dir>/scripts/handback.ts" check design/prototypes/flow
   ```

The checker rejects forbidden text in files and rendered scenario text, conflict markers and unreviewed report
entries, missing review evidence or a failing bar, nested `uploads/uploads/`,
hash-suffixed uploads, stale screenshots, external requests, browser errors and
horizontal overflow. It renders every scenario at every configured width.
Verification images go to `.handback-render/`; delivered screenshot evidence is preserved.
Scenarios cannot load that directory or `handback-report.json`.
Unsupported embedded frames fail closed; workers, service workers and new
windows are held paused when created and fail the check. The browser reaches
only the bundle's temporary local server: every other connection, WebSockets
included, is refused at the browser's proxy, and the page's external requests
and WebSockets are reported as failures.
Page inspections run in an isolated script context, so the bundle's own
scripts cannot change what the check reads. Rendered text includes form
control values and placeholders.

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
