# Numbers that stay

- At most 3 retries, then the job fails; a timeout of 30 seconds.
- Each message is ≤ 8000 chars, and up to 20 files per batch.
- Step 4 runs the checks; see section 2, tier 1 tools and phase 3 jobs.
- Keys and versions: ADR-0012, v2.1, #44, 2026-10-01, 80% of files, 5+ files.
- A code span (`6 passes`) and a fence are illustrations:

```text
The 6 passes are: format, lint, types, tests, build, links.
```

2. Templates come second in this list; the marker is not a count.

- 120 skills ship with the plugin <!-- measured: ls skills | wc -l -->
- One file, 1 module: a count below two is not a tally.
