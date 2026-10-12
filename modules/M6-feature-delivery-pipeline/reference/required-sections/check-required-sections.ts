// Required-sections gate — a stage artifact carries every REQUIRED heading.
//
// The feature pipeline's promise is that "each stage produces a NAMED artifact
// from a committed template" (a PRD, an architecture doc, a research note). A
// template is only real if the artifact actually keeps its required headings, so
// a downstream stage can rely on finding them. This gate reads a markdown
// artifact and a list of required section headings and fails if any is absent.
//
// Inputs:
//   * ARTIFACT  — the markdown file to check      (arg 1 or ARTIFACT env)
//   * the required headings, from EITHER:
//       - SECTIONS env — a list of heading labels, one per line or `|`-separated
//         (wins when set), OR
//       - a manifest file (arg 2 or MANIFEST env) — one heading label per line;
//         blank lines and `# comment` lines ignored.
//     Labels are plain heading text ("Success metrics"), not `## Success metrics`.
//
// Matching is forgiving (low false alarm): a required label matches any ATX
// heading (`#`..`######`) in the artifact whose text is equal after trimming
// whitespace, dropping the leading `#` markers, a trailing `:` and any closing
// `#`, and lowercasing. Only rendered headings count: headings inside fenced or
// indented code blocks, HTML comments and the frontmatter block are ignored.
//
// Conventions: exit 0 all present, 1 a required heading missing, 2 usage/format
// error (no artifact, file not found, no required sections given).
//
// Usage:
//   check-required-sections.ts prd.md sections.txt
//   SECTIONS='Problem statement|Success metrics' check-required-sections.ts prd.md
//   ARTIFACT=prd.md MANIFEST=sections.txt check-required-sections.ts
import { runGate } from "../../../../lib/module-gates.ts";

if (import.meta.main)
  process.exitCode = await runGate("check-required-sections");
