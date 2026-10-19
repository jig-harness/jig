#!/usr/bin/env bun
/**
 * Check a decision-rules catalog after editing it.
 *
 * Usage: bun validate-rules.ts <rules-file>
 *
 * Checks that the file parses as YAML (a duplicated key is an error, not a
 * silent overwrite), that every rule in every top-level `*_rules` list has an
 * id, that no id appears twice, that every `pattern_rules` entry has a
 * nonempty `pattern`, that every `severity` is one the interpreter knows, and
 * that every `pattern` and `follow_check` compiles, and that every `exclude`
 * glob compiles once turned into the interpreter's regular expression (an
 * unclosed `[` would otherwise abort enforcement the first time a file is
 * checked). The interpreter skips a
 * rule without a pattern and treats any severity other than `critical` as a
 * warning, so either mistake would weaken enforcement without a word. POSIX character classes such as `[[:space:]]` are translated the
 * way Jig's reference interpreter (module M5) translates them, so a
 * class that interpreter would reject is rejected here too.
 *
 * That interpreter does not parse YAML: it reads `pattern_rules` line by line,
 * starts a rule only at an indented `- id:` line, and takes each field's value
 * from the field's own line, minus one pair of surrounding quotes. So the
 * `pattern_rules` entries are also read that way here and compared with the
 * YAML reading; any difference is a problem. That catches an entry that does
 * not open with `- id:` (the interpreter skips it or hands its fields to the
 * rule before), an inline `# comment` (the interpreter keeps it as part of the
 * value, so `severity: critical # note` counts as a warning), a block scalar
 * (`|` or `>`), a block-list `exclude`, and double-quote escapes.
 *
 * Exit codes: 0 valid; 1 problems found (listed); 2 the file cannot be read or
 * parsed.
 */
import { readFileSync } from "node:fs";
import { load } from "../../../shared/yaml.ts";

const POSIX_CLASSES: Record<string, string> = {
  space: "\\s",
  blank: " \\t",
  digit: "0-9",
  alpha: "A-Za-z",
  alnum: "A-Za-z0-9",
  lower: "a-z",
  upper: "A-Z",
  xdigit: "A-Fa-f0-9",
  cntrl: "\\x00-\\x1f\\x7f",
  print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e",
  punct: "!-/:-@\\[-`{-~",
};

export function compile(pattern: string): RegExp {
  return new RegExp(
    pattern.replace(/\[:([a-z]+):\]/g, (_match, name: string) => {
      const value = POSIX_CLASSES[name];
      if (value === undefined)
        throw new Error(`unsupported POSIX character class: ${name}`);
      return value;
    }),
  );
}

/**
 * The regular expression M5's interpreter builds from an `exclude` glob.
 * Mirrors `globMatches` in
 * modules/M5-adr-practice/reference/decisions-to-checks/adr-rules-check.ts;
 * keep the two in step.
 */
export function compileGlob(glob: string): RegExp {
  return compile(
    `^${glob.replace(/\./g, "\\.").replace(/\*\*/g, "\x01").replace(/\*/g, "[^/]*").split("\x01").join(".*")}$`,
  );
}

/**
 * The globs M5's interpreter takes from an `exclude` value: the entries
 * joined by commas, whitespace and quotes removed, split on commas.
 */
function excludeGlobs(value: unknown[] | string): string[] {
  return (Array.isArray(value) ? value.join(",") : value)
    .replace(/[\s"']/g, "")
    .split(",")
    .filter(Boolean);
}

export const SEVERITIES = ["critical", "warning", "info"];

export interface Summary {
  problems: string[];
  counts: Record<string, number>;
}

export function validateRules(catalog: unknown): Summary {
  const problems: string[] = [];
  const counts: Record<string, number> = {};
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog))
    return { problems: ["the catalog must be a mapping"], counts };
  const seen = new Map<string, string>();
  for (const [section, rules] of Object.entries(catalog)) {
    if (!section.endsWith("_rules")) continue;
    if (!Array.isArray(rules)) {
      problems.push(`${section} must be a list`);
      continue;
    }
    counts[section] = rules.length;
    rules.forEach((rule: unknown, index) => {
      const where = `${section}[${index}]`;
      if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
        problems.push(`${where} must be a mapping`);
        return;
      }
      const fields = rule as Record<string, unknown>;
      const id = fields.id;
      if (typeof id !== "string" || id.trim() === "")
        problems.push(`${where} has no id`);
      else if (seen.has(id))
        problems.push(`duplicate id ${id} (${seen.get(id)} and ${where})`);
      else seen.set(id, where);
      const label = typeof id === "string" && id ? id : where;
      if (
        section === "pattern_rules" &&
        (fields.pattern === undefined || fields.pattern === "")
      )
        problems.push(`${label}: pattern_rules entry has no pattern`);
      const severity = fields.severity;
      if (
        severity !== undefined &&
        (typeof severity !== "string" || !SEVERITIES.includes(severity))
      )
        problems.push(
          `${label}: severity must be one of ${SEVERITIES.join(", ")} (got ${String(severity)})`,
        );
      for (const key of ["pattern", "follow_check"]) {
        const value = fields[key];
        if (value === undefined) continue;
        if (typeof value !== "string") {
          problems.push(`${label}: ${key} must be a string`);
          continue;
        }
        try {
          compile(value);
        } catch (error) {
          problems.push(
            `${label}: ${key} does not compile: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
      const exclude = fields.exclude;
      if (exclude === undefined || exclude === null) return;
      if (
        typeof exclude !== "string" &&
        !(
          Array.isArray(exclude) &&
          exclude.every((glob) => typeof glob === "string")
        )
      ) {
        problems.push(`${label}: exclude must be a list of globs`);
        return;
      }
      for (const glob of excludeGlobs(exclude)) {
        try {
          compileGlob(glob);
        } catch (error) {
          problems.push(
            `${label}: exclude glob ${JSON.stringify(glob)} does not compile: ${error instanceof Error ? error.message : error}`,
          );
        }
      }
    });
  }
  return { problems, counts };
}

/** The fields of a `pattern_rules` entry that M5's interpreter reads. */
const READ_FIELDS = [
  "id",
  "severity",
  "pattern",
  "follow_check",
  "exclude",
  "message",
] as const;
type ReadField = (typeof READ_FIELDS)[number];

/** A field's value as M5's interpreter reads it from the field's line. */
function interpreterValue(key: ReadField, line: string): string {
  if (key === "exclude")
    return line
      .replace(/^[^:]*:\s*\[/, "")
      .replace(/\]\s*$/, "")
      .replace(/[\s"']/g, "");
  return line.replace(/^[^:]*:\s*/, "").replace(/^["']|["']\s*$/g, "");
}

/** A field's YAML value in the form the interpreter's reading should equal. */
function yamlValue(key: ReadField, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (key === "exclude")
    return (Array.isArray(value) ? value.join(",") : String(value)).replace(
      /[\s"']/g,
      "",
    );
  return String(value);
}

interface ReadRule {
  line: number;
  fields: Map<ReadField, { value: string; line: number }>;
}

/**
 * Problems where M5's line-by-line interpreter would read `pattern_rules`
 * differently from the YAML parse of the same text.
 */
export function interpreterProblems(text: string, catalog: unknown): string[] {
  const problems: string[] = [];
  const read: ReadRule[] = [];
  let inRules = false;
  let entryIndent: number | undefined;
  let rule: ReadRule | undefined;
  text.split("\n").forEach((line, index) => {
    const number = index + 1;
    if (/^pattern_rules:/.test(line)) {
      inRules = true;
      return;
    }
    if (inRules && /^[a-z_]/.test(line)) inRules = false;
    if (!inRules) return;
    if (/^\s+-\s*id:/.test(line)) {
      entryIndent ??= line.indexOf("-");
      rule = { line: number, fields: new Map() };
      rule.fields.set("id", {
        value: interpreterValue("id", line),
        line: number,
      });
      read.push(rule);
      return;
    }
    const dash = line.match(/^\s*(?=-(\s|$))/)?.[0];
    if (
      dash !== undefined &&
      (entryIndent === undefined || dash.length <= entryIndent)
    ) {
      problems.push(
        `line ${number}: a pattern_rules entry must open with an indented "- id:" line; the interpreter starts a rule nowhere else`,
      );
      return;
    }
    if (!rule) return;
    const field = line.match(
      /^\s+(severity|pattern|follow_check|exclude|message):/,
    );
    if (!field) return;
    const key = field[1] as ReadField;
    rule.fields.set(key, { value: interpreterValue(key, line), line: number });
  });

  const entries = (catalog as Record<string, unknown> | null)?.pattern_rules;
  if (!Array.isArray(entries)) return problems;
  if (problems.length) return problems;
  if (read.length !== entries.length) {
    problems.push(
      `the interpreter reads ${read.length} pattern_rules entries where the YAML has ${entries.length}`,
    );
    return problems;
  }
  read.forEach((reading, index) => {
    const entry = entries[index];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const fields = entry as Record<string, unknown>;
    const label =
      typeof fields.id === "string" && fields.id
        ? fields.id
        : `pattern_rules[${index}]`;
    for (const key of READ_FIELDS) {
      const got = reading.fields.get(key);
      const expected = yamlValue(key, fields[key]);
      const value = got?.value ?? "";
      if (value === expected) continue;
      const hint = /^[|>]/.test(value)
        ? "; a block scalar is read as its indicator alone, so write the value on the field's line"
        : /\s#/.test(value)
          ? "; the interpreter keeps an inline # comment as part of the value, so move the comment to its own line"
          : "";
      problems.push(
        `${label} (line ${got?.line ?? reading.line}): the interpreter reads ${key} as ${JSON.stringify(value)}, the YAML as ${JSON.stringify(expected)}${hint}`,
      );
    }
  });
  return problems;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: bun validate-rules.ts <rules-file>");
    process.exitCode = 2;
  } else {
    let catalog: unknown;
    let text = "";
    try {
      text = readFileSync(file, "utf8");
      catalog = load(text);
    } catch (error) {
      console.error(
        `validate-rules: ${file}: ${error instanceof Error ? error.message : error}`,
      );
      process.exitCode = 2;
    }
    if (process.exitCode !== 2) {
      const { problems, counts } = validateRules(catalog);
      problems.push(...interpreterProblems(text, catalog));
      for (const problem of problems) console.log(`ERROR ${problem}`);
      const summary = Object.entries(counts)
        .map(([section, count]) => `${count} ${section}`)
        .join(", ");
      console.log(
        problems.length
          ? `${problems.length} problem(s) in ${file}`
          : `OK — ${file}: ${summary || "no rule lists"}`,
      );
      process.exitCode = problems.length ? 1 : 0;
    }
  }
}
