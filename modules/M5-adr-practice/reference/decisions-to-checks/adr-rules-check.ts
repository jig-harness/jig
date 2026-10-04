#!/usr/bin/env bun
// Interpret the small pattern_rules catalog without YAML scalar coercion.
import { existsSync, readFileSync, statSync } from "node:fs";
interface Rule {
  id: string;
  severity: string;
  pattern: string;
  follow_check: string;
  exclude: string;
  message: string;
}
const stripQuote = (value: string) =>
  value.replace(/^[^:]*:\s*/, "").replace(/^["']|["']\s*$/g, "");
export function parseRules(text: string): Rule[] {
  const rules: Rule[] = [];
  let inRules = false;
  let rule: Rule | undefined;
  for (const line of text.split("\n")) {
    if (/^pattern_rules:/.test(line)) {
      inRules = true;
      continue;
    }
    if (inRules && /^[a-z_]/.test(line)) inRules = false;
    if (!inRules) continue;
    if (/^\s+-\s*id:/.test(line)) {
      rule = {
        id: stripQuote(line),
        severity: "",
        pattern: "",
        follow_check: "",
        exclude: "",
        message: "",
      };
      rules.push(rule);
      continue;
    }
    if (!rule) continue;
    const field = line.match(
      /^\s+(severity|pattern|follow_check|exclude|message):/,
    );
    if (!field) continue;
    const key = field[1] as keyof Rule;
    rule[key] =
      key === "exclude"
        ? line
            .replace(/^[^:]*:\s*\[/, "")
            .replace(/\]\s*$/, "")
            .replace(/[\s"']/g, "")
        : stripQuote(line);
  }
  return rules;
}
// JavaScript accepts the common ERE constructs used by this catalog; translate
// POSIX character classes explicitly rather than silently changing their meaning.
export function ere(pattern: string): RegExp {
  const classes: Record<string, string> = {
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
  return new RegExp(
    pattern.replace(/\[:([a-z]+):\]/g, (_match, name: string) => {
      const value = classes[name];
      if (value === undefined)
        throw new Error(`unsupported POSIX character class: ${name}`);
      return value;
    }),
  );
}
export function globMatches(
  path: string,
  glob: string,
  platform = process.platform,
): boolean {
  // Catalog globs use / on every OS; preserve literal backslashes on POSIX.
  const candidate = platform === "win32" ? path.replaceAll("\\", "/") : path;
  return ere(
    `^${glob.replace(/\./g, "\\.").replace(/\*\*/g, "\x01").replace(/\*/g, "[^/]*").split("\x01").join(".*")}$`,
  ).test(candidate);
}
export function checkAdrRules(
  args = process.argv.slice(2),
  env = process.env,
): number {
  const catalog = env.RULES || ".adr-rules.yaml";
  if (!existsSync(catalog)) throw new Error(`rules file not found: ${catalog}`);
  if (!args.length) {
    console.log("OK — no files to check");
    return 0;
  }
  let critical = 0;
  let warnings = 0;
  const window = Number(env.WINDOW || "2");
  if (!Number.isSafeInteger(window))
    throw new Error("WINDOW must be a safe integer");
  for (const rule of parseRules(readFileSync(catalog, "utf8"))) {
    if (!rule.pattern) continue;
    const pattern = ere(rule.pattern);
    const follow = rule.follow_check ? ere(rule.follow_check) : undefined;
    for (const file of args) {
      if (
        !existsSync(file) ||
        !statSync(file).isFile() ||
        rule.exclude
          .split(",")
          .filter(Boolean)
          .some((glob) => globMatches(file, glob))
      )
        continue;
      const text = readFileSync(file, "utf8");
      if (text.includes("\0") && !follow) continue;
      const lines = text.replace(/\n$/, "").split("\n");
      const hits: string[] = [];
      for (const [index, line] of lines.entries()) {
        if (!pattern.test(line)) continue;
        if (
          follow &&
          window >= 0 &&
          lines
            .slice(index, index + window + 1)
            .some((line) => follow.test(line))
        )
          continue;
        hits.push(`${index + 1}:${follow ? " " : ""}${line}`);
      }
      if (!hits.length) continue;
      const severity = rule.severity || "warning";
      console.log(
        `[${severity}] ${file} — ${rule.message} [${rule.id}]\n${hits.map((hit) => `    ${hit}`).join("\n")}`,
      );
      if (severity === "critical" || env.STRICT === "1") critical++;
      else warnings++;
    }
  }
  console.log("");
  if (critical) {
    console.log(
      `${critical} blocking ADR-rule violation(s)${warnings ? `, ${warnings} warning(s)` : ""}.`,
    );
    return 1;
  }
  if (warnings)
    console.log(
      `${warnings} ADR-rule warning(s) (non-blocking; STRICT=1 to fail).`,
    );
  console.log("OK — no blocking ADR-rule violations");
  return 0;
}
if (import.meta.main) {
  try {
    process.exitCode = checkAdrRules();
  } catch (error) {
    console.error(`ERROR: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 2;
  }
}
