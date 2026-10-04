#!/usr/bin/env bun
// Schema-controlled frontmatter gate. The regular schema structure remains
// intentionally small; runtime YAML coercion must not change scalar meanings.
import { readFileSync, existsSync } from "node:fs";
import { cli, frontmatterValue, markdownFiles, readDocument } from "../docs";

function block(schema: string, key: string): string[] {
  const lines = schema.split("\n");
  const start = lines.findIndex((line) =>
    new RegExp(`^${key}:\\s*$`).test(line),
  );
  if (start < 0) return [];
  const end = lines.findIndex(
    (line, index) => index > start && /^[a-z_]+:/.test(line),
  );
  return lines.slice(start + 1, end < 0 ? undefined : end);
}
const list = (lines: string[]) =>
  lines
    .filter((line) => /^\s+-\s/.test(line))
    .map((line) =>
      line
        .replace(/^\s+-\s*/, "")
        .replace(/\s*#.*/, "")
        .replace(/\s/g, ""),
    )
    .filter(Boolean);

export function checkFrontmatter(
  args = process.argv.slice(2),
  env = process.env,
): number {
  const schemaFile = env.SCHEMA || "docs/.frontmatter-schema.yaml";
  if (!existsSync(schemaFile))
    throw new Error(`schema not found: ${schemaFile}`);
  const schema = readFileSync(schemaFile, "utf8");
  const required = list(block(schema, "required"));
  const requiredNew = list(block(schema, "required_new"));
  const canonical = list(block(schema, "tags"));
  const typeSpecific = block(schema, "type_specific");
  const adrStart = typeSpecific.findIndex((line) => /^\s+adr:\s*$/.test(line));
  const adrEnd = typeSpecific.findIndex(
    (line, index) =>
      index > adrStart && /^ {2}[a-z]/.test(line) && !/^\s+adr:/.test(line),
  );
  const adrRequired =
    adrStart < 0
      ? []
      : list(typeSpecific.slice(adrStart + 1, adrEnd < 0 ? undefined : adrEnd));
  const files = args.length ? args : markdownFiles(env.DOCS_DIR || "docs");
  let errors = 0;
  for (const file of files) {
    if (!file) continue;
    const text = readDocument(file);
    const lines = text.split("\n");
    const errs: string[] = [];
    const value = (key: string) => frontmatterValue(text, key);
    if (!/^---\s*$/.test(lines[0] ?? ""))
      errs.push("no frontmatter (must open with ---)");
    else if (!lines.slice(1, 60).some((line) => /^---\s*$/.test(line)))
      errs.push("frontmatter not closed within first 60 lines");
    else {
      for (const key of required)
        if (!value(key)) errs.push(`missing required field: ${key}`);
      if (` ${env.NEW_DOCS || ""} `.includes(` ${file} `))
        for (const key of requiredNew)
          if (!value(key)) errs.push(`new doc missing required field: ${key}`);
      for (const field of ["type", "status", "lifecycle", "owner"]) {
        const v = value(field);
        if (!v) continue;
        const section = block(schema, field);
        const enumLine =
          section.find((line) => /^\s+values:\s*\[/.test(line)) ?? "";
        const values = enumLine
          .replace(/^[^[]*\[/, "")
          .replace(/\].*/, "")
          .replace(/\s/g, "")
          .split(",");
        if (values.includes(v)) continue;
        let hint = "";
        let suggestions = false;
        for (const line of section) {
          if (/^ {2}suggestions:\s*$/.test(line)) {
            suggestions = true;
            continue;
          }
          if (suggestions && /^ {2}[a-z]/.test(line)) suggestions = false;
          if (suggestions && /^ {4}[^ ]/.test(line)) {
            const parts = line
              .replace(/"/g, "")
              .trimStart()
              .replace(/:\s*/, " ")
              .split(/\s+/);
            if (parts[0] === v) {
              hint = parts[1] ?? "";
              break;
            }
          }
        }
        errs.push(
          `invalid ${field} '${v}' (${hint ? `did you mean '${hint}'?` : "not in schema enum"})`,
        );
      }
      const updated = value("last_updated");
      if (updated && !/^\d{4}-\d{2}-\d{2}$/.test(updated))
        errs.push(`last_updated '${updated}' is not YYYY-MM-DD`);
      const tags = value("tags");
      if (tags) {
        if (!/^\[.*\]$/.test(tags))
          errs.push("tags must be a bracketed list: [a, b]");
        else {
          const tokens = tags
            .slice(1, -1)
            .replace(/,/g, " ")
            .split(/\s+/)
            .filter(Boolean);
          for (const tag of tokens)
            if (!canonical.includes(tag))
              errs.push(
                `unknown tag '${tag}' (not in canonical list; run the tag normalizer)`,
              );
          if (tokens.length > 8)
            errs.push(`too many tags (${tokens.length} > 8)`);
        }
      }
      if (value("type") === "adr") {
        for (const key of adrRequired)
          if (!value(key)) errs.push(`adr missing required field: ${key}`);
        const date = value("decision_date");
        if (date && date !== "~" && !/^\d{4}-\d{2}-\d{2}$/.test(date))
          errs.push(`decision_date '${date}' is not YYYY-MM-DD`);
      }
    }
    if (errs.length) {
      console.log(
        `FAIL ${file}\n${errs.map((error) => `  - ${error}`).join("\n")}`,
      );
      errors++;
    }
  }
  if (errors) {
    console.log(`\n${errors} doc(s) failed frontmatter validation.`);
    return 1;
  }
  console.log("OK — frontmatter valid");
  return 0;
}
if (import.meta.main) cli(() => checkFrontmatter());
