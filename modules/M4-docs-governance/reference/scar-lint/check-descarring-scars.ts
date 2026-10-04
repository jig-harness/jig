#!/usr/bin/env bun
// Scan approved docs only, masking fenced and inline code before scar checks.
import { cli, frontmatterValue, markdownFiles, readDocument } from "../docs";
export function scanScars(text: string): string[] {
  let fence = false;
  const hits: string[] = [];
  for (const [index, raw] of text.replace(/\n$/, "").split("\n").entries()) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const line = raw.replace(/`[^`]*`/g, "  ");
    const low = line.toLowerCase();
    if (
      /~~[^~]+~~/.test(line) ||
      (/^\s*([-*>]|\d+\.)\s+/.test(line) &&
        (/(addressed|fixed as suggested|good catch|as per review|as requested|resolved per review|done as suggested)/.test(
          low,
        ) ||
          /(reviewer|coderabbit|codex|copilot|shadow reviewer)\s*:/.test(low)))
    )
      hits.push(`${index + 1}: ${raw}`);
  }
  return hits;
}
export function checkDescarring(
  args = process.argv.slice(2),
  env = process.env,
): number {
  const files = args.length ? args : markdownFiles(env.DOCS_DIR || "docs");
  const allowlist = (env.ALLOWLIST || "").split(/\s+/).filter(Boolean);
  let count = 0;
  for (const file of files) {
    if (!file) continue;
    const text = readDocument(file);
    if (
      frontmatterValue(text, "status") !== "approved" ||
      frontmatterValue(text, "descar_allow") === "true" ||
      allowlist.some((pattern) => file.includes(pattern))
    )
      continue;
    const hits = scanScars(text);
    if (hits.length) {
      console.log(`SCAR ${file}\n${hits.map((hit) => `  ${hit}`).join("\n")}`);
      count++;
    }
  }
  if (count) {
    console.log(
      `\n${count} approved doc(s) carry review scars — move them to the\nreview thread / issue / a ## Version history section, or set\ndescar_allow: true if the doc's subject is the review process.`,
    );
    return 1;
  }
  console.log("OK — no scars in approved docs");
  return 0;
}
if (import.meta.main) cli(() => checkDescarring());
