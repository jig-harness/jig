#!/usr/bin/env bun
// Scan approved docs only, masking fenced and inline code before scar checks.
import {
  cli,
  frontmatterValue,
  markdownFiles,
  readDocument,
  splitLines,
} from "../docs";
export function scanScars(text: string): string[] {
  let fence = false;
  const hits: string[] = [];
  for (const [index, raw] of splitLines(text).entries()) {
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
const SKIPPED_NOTE =
  "were not scanned for scars (their status is not approved); this is not evidence they are clean";

const listed = (files: string[]) =>
  files.map((file) => `    ${file}`).join("\n");

interface Scan {
  /** Approved docs that carry scars. */
  scarred: number;
  /** Named files left unscanned because they are not approved. */
  skipped: string[];
}

function exempt(file: string, text: string, allowlist: string[]): boolean {
  return (
    frontmatterValue(text, "descar_allow", file) === "true" ||
    allowlist.some((pattern) => file.includes(pattern))
  );
}

function scanFiles(files: string[], named: boolean, allowlist: string[]): Scan {
  const scan: Scan = { scarred: 0, skipped: [] };
  for (const file of files) {
    const text = readDocument(file);
    if (frontmatterValue(text, "status", file) !== "approved") {
      if (named) scan.skipped.push(file);
      continue;
    }
    const hits = exempt(file, text, allowlist) ? [] : scanScars(text);
    if (!hits.length) continue;
    console.log(`SCAR ${file}\n${hits.map((hit) => `  ${hit}`).join("\n")}`);
    scan.scarred++;
  }
  return scan;
}

/** Print the verdict for a scan; the exit code follows the scars alone. */
function verdict(scan: Scan, scanned: number): number {
  const { scarred, skipped } = scan;
  const note = `NOTE — ${skipped.length} of the named file(s) ${SKIPPED_NOTE}. Skipped:\n${listed(skipped)}`;
  if (scarred) {
    console.log(
      `\n${scarred} approved doc(s) carry review scars — move them to the\nreview thread / issue / a ## Version history section, or set\ndescar_allow: true if the doc's subject is the review process.`,
    );
    if (skipped.length) console.log(`\n${note}`);
    return 1;
  }
  if (skipped.length && skipped.length === scanned) {
    console.log(
      `NOT SCANNED — ${skipped.length} named file(s) ${SKIPPED_NOTE}. Named:\n${listed(skipped)}`,
    );
    return 0;
  }
  console.log("OK — no scars in approved docs");
  if (skipped.length) console.log(note);
  return 0;
}

/**
 * Named files are reported even when they are not scanned: a file named on the
 * command line that is not promoted is listed as NOT SCANNED, so a caller can
 * tell "scanned, clean" from "never in scope". A full-tree run names nothing,
 * so it reports plain OK.
 */
export function checkDescarring(
  args = process.argv.slice(2),
  env = process.env,
): number {
  const named = args.length > 0;
  const files = (named ? args : markdownFiles(env.DOCS_DIR || "docs")).filter(
    Boolean,
  );
  const allowlist = (env.ALLOWLIST || "").split(/\s+/).filter(Boolean);
  return verdict(scanFiles(files, named, allowlist), files.length);
}
if (import.meta.main) cli(() => checkDescarring());
