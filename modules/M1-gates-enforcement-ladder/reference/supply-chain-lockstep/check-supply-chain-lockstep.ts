#!/usr/bin/env bun
// Supply-chain policy lockstep: every installer and the updater state the
// one policy, or the gate says which does not.
//
// The problem it catches. A release cooldown, its exemptions and the list of
// packages allowed to run install scripts are each enforced in several
// places: by the dependency updater when it proposes a bump, and by every
// package manager at install time, each in its own file and its own unit
// (days, minutes, seconds). Edited by hand, the copies drift: one installer
// is weakened to no cooldown while the others still hold, a package allowed
// to run scripts under one installer is blocked under another, the updater
// exempts a package the installers do not. Nothing else notices, because
// each file is valid on its own. This gate reads the policy from one file
// and checks that every installer and updater file given states exactly it.
//
// The policy (YAML):
//   cooldown:
//     days: 3                 # a whole number of days, at least 1
//     exempt: [typescript]    # exact package names; never a pattern
//   install-scripts:
//     allow: [esbuild]        # packages that may run lifecycle scripts
//
// What each file must state (absent list == empty list, except where noted):
//   --bunfig          [install] minimumReleaseAge = days in seconds;
//                     minimumReleaseAgeExcludes == exempt
//   --package-json    trustedDependencies == allow (Bun's allowlist), set
//                     even when empty, and never null: omitted, Bun runs the
//                     install scripts of its own built-in list of trusted
//                     packages
//   --pnpm-workspace  onlyBuiltDependencies == allow, and no other setting
//                     that grants builds (dangerouslyAllowAllBuilds,
//                     neverBuiltDependencies, onlyBuiltDependenciesFile, an
//                     allowBuilds entry that is not false);
//                     minimumReleaseAge = days in minutes;
//                     minimumReleaseAgeExclude == exempt
//   --npmrc           for a pnpm version that still reads its settings from
//                     .npmrc, and only beside --pnpm-workspace, which is
//                     checked in full either way: minimum-release-age = days
//                     in minutes; minimum-release-age-exclude[] == exempt;
//                     and no build grant at all (the allowlist lives in the
//                     workspace file). Read as npm's ini parser reads it (a
//                     bare key is true, quoted keys are unquoted, camel and
//                     kebab case are one key); a [section] is could not check
//   --renovate        minimumReleaseAge == days; internalChecksFilter strict;
//                     at most one packageRule with minimumReleaseAge 0, naming
//                     exactly exempt in matchPackageNames and selecting by
//                     nothing else; no rule shortening the cooldown; when
//                     allow is not empty, exactly one packageRule with
//                     automerge: false naming exactly allow, selecting by
//                     nothing else, and it is the last rule, since a later
//                     rule overrides an earlier one
//   --dependabot      every npm or bun updates entry: cooldown.default-days ==
//                     days, no semver-*-days below it, no include, exclude ==
//                     exempt
//
// Fail closed. A policy that is missing, empty or not of the shape above (a
// pattern where an exact name is required, a cooldown under one day), a file
// that cannot be read or parsed, or a run naming no installer or updater file
// exits 2: input the gate could not read never passes. A file that parses but
// does not state the policy is a finding (exit 1): the installer would run
// without the policy. Each file is checked on its own: one that cannot be
// read is reported and does not stop the others, and a finding in any file
// makes the exit 1 even when another could not be checked.
//
// Exit codes: 0 every file agrees, 1 at least one does not, 2 could not check
// and no file disagrees.
//
// Usage:
//   check-supply-chain-lockstep.ts --policy <policy.yaml> [--bunfig <bunfig.toml>]
//     [--package-json <package.json>] [--npmrc <.npmrc>]
//     [--pnpm-workspace <pnpm-workspace.yaml>] [--renovate <renovate.json5>]
//     [--dependabot <dependabot.yml>] [--root <dir>]
import { readFileSync } from "node:fs";
import { cli } from "../../../../lib/cli.ts";
import {
  couldNotCheck,
  type Finding,
  repoPath,
  reportFindings,
} from "../../../../lib/findings.ts";
import { isRecord } from "../../../../lib/record.ts";
import { load as loadYaml } from "../../../../lib/vendor/js-yaml.mjs";

export const RULE = "supply-chain-lockstep";

/** Thrown for input the check cannot read; the boundary turns it into exit 2. */
export class Unreadable extends Error {}

const usage =
  "usage: check-supply-chain-lockstep.ts --policy <policy.yaml> [--bunfig <bunfig.toml>] [--package-json <package.json>] [--npmrc <.npmrc>] [--pnpm-workspace <pnpm-workspace.yaml>] [--renovate <renovate.json5>] [--dependabot <dependabot.yml>] [--root <dir>]";

export interface Policy {
  /** The cooldown, in whole days, at least 1. */
  days: number;
  /** Exact names of the packages the cooldown does not apply to. */
  exempt: string[];
  /** Exact names of the packages that may run lifecycle scripts. */
  allow: string[];
}

export const READERS = [
  "bunfig",
  "package-json",
  "npmrc",
  "pnpm-workspace",
  "renovate",
  "dependabot",
] as const;
export type Reader = (typeof READERS)[number];

const SECONDS = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800 };

/** An exact npm package name: an optional scope, then the name; no pattern. */
const EXACT_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const show = (value: unknown): string =>
  value === undefined ? "nothing" : JSON.stringify(value);

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A policy list as exact package names; throw on anything else. A pattern
 * (`@scope/*`, a regex, a negation) would quietly trust whatever it matches
 * later, so the policy names each package.
 */
function exactNames(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Unreadable(`${what} is not a list`);
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !EXACT_NAME.test(entry))
      throw new Unreadable(
        `${what} has an entry that is not an exact package name: ${show(entry)}`,
      );
    if (names.includes(entry))
      throw new Unreadable(`${what} lists ${entry} twice`);
    names.push(entry);
  }
  return names;
}

/** The policy, or throw when the text is not one. */
export function parsePolicy(text: string, path: string): Policy {
  if (!text.trim())
    throw new Unreadable(`${path} is empty: a policy states cooldown.days`);
  let doc: unknown;
  try {
    doc = loadYaml(text);
  } catch (error) {
    throw new Unreadable(`${path} is not YAML: ${message(error)}`);
  }
  if (!isRecord(doc)) throw new Unreadable(`${path} is not a mapping`);
  const cooldown = doc.cooldown;
  if (!isRecord(cooldown)) throw new Unreadable(`${path}: cooldown is missing`);
  const days = cooldown.days;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1)
    throw new Unreadable(
      `${path}: cooldown.days must be a whole number of days, at least 1; got ${show(days)}`,
    );
  const exempt = exactNames(cooldown.exempt, `${path}: cooldown.exempt`);
  const scripts = doc["install-scripts"];
  if (scripts !== undefined && scripts !== null && !isRecord(scripts))
    throw new Unreadable(`${path}: install-scripts is not a mapping`);
  const allow = exactNames(
    isRecord(scripts) ? scripts.allow : undefined,
    `${path}: install-scripts.allow`,
  );
  return { days, exempt, allow };
}

type Make = (problem: string, remedy: string) => Finding;

/** Findings for a file's list against the policy's; absent counts as empty. */
function listAgrees(
  found: unknown,
  expected: string[],
  file: string,
  field: string,
  policyList: string,
): Finding[] {
  const finding: Make = (problem, remedy) => ({
    rule: RULE,
    file,
    problem,
    remedy,
  });
  if (found === undefined || found === null) found = [];
  if (!Array.isArray(found) || found.some((e) => typeof e !== "string"))
    return [
      finding(
        `${field} is not a list of package names: ${show(found)}`,
        `list the policy's ${policyList} packages there`,
      ),
    ];
  const names = found as string[];
  return [
    ...nameShapes(names, field, policyList, finding),
    ...membership(names, expected, field, policyList, finding),
  ];
}

/** A name that is a pattern, and a name listed twice. */
function nameShapes(
  names: string[],
  field: string,
  policyList: string,
  finding: Make,
): Finding[] {
  const findings: Finding[] = [];
  for (const name of names)
    if (!EXACT_NAME.test(name))
      findings.push(
        finding(
          `${field} names a pattern, not an exact package name: ${name}`,
          `name each package; the policy's ${policyList} list is exact`,
        ),
      );
  for (const name of new Set(names.filter((n, i) => names.indexOf(n) !== i)))
    findings.push(finding(`${field} lists ${name} twice`, "list it once"));
  return findings;
}

/** A name the policy does not list, and a policy name the file does not. */
function membership(
  names: string[],
  expected: string[],
  field: string,
  policyList: string,
  finding: Make,
): Finding[] {
  const findings: Finding[] = [];
  for (const name of names)
    if (!expected.includes(name) && EXACT_NAME.test(name))
      findings.push(
        finding(
          `${field} lists ${name}, which the policy's ${policyList} does not`,
          `remove it, or add it to ${policyList} in the policy`,
        ),
      );
  for (const name of expected)
    if (!names.includes(name))
      findings.push(
        finding(
          `${field} does not list ${name}, which the policy's ${policyList} names`,
          `add it to ${field}`,
        ),
      );
  return findings;
}

/** A duration such as `3 days` in seconds, or undefined when it is not one. */
export function durationSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d+)\s*(second|minute|hour|day|week)s?$/i.exec(value.trim());
  const unit = m?.[2]?.toLowerCase();
  if (!m || unit === undefined || !Object.hasOwn(SECONDS, unit))
    return undefined;
  return Number(m[1]) * SECONDS[unit as keyof typeof SECONDS];
}

function checkBunfig(text: string, file: string, policy: Policy): Finding[] {
  let doc: unknown;
  try {
    doc = Bun.TOML.parse(text);
  } catch (error) {
    throw new Unreadable(`${file} is not TOML: ${message(error)}`);
  }
  const install = isRecord(doc) && isRecord(doc.install) ? doc.install : {};
  const want = policy.days * SECONDS.day;
  const findings: Finding[] = [];
  const age = install.minimumReleaseAge;
  if (age !== want)
    findings.push({
      rule: RULE,
      file,
      problem: `[install] minimumReleaseAge is ${show(age)}; the policy's cooldown is ${plural(policy.days, "day")} (${want} seconds)`,
      remedy: `set minimumReleaseAge = ${want} under [install]`,
    });
  findings.push(
    ...listAgrees(
      install.minimumReleaseAgeExcludes,
      policy.exempt,
      file,
      "[install] minimumReleaseAgeExcludes",
      "cooldown.exempt",
    ),
  );
  return findings;
}

function checkPackageJson(
  text: string,
  file: string,
  policy: Policy,
): Finding[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new Unreadable(`${file} is not JSON: ${message(error)}`);
  }
  if (!isRecord(doc)) throw new Unreadable(`${file} is not an object`);
  if (doc.trustedDependencies === undefined)
    return [
      {
        rule: RULE,
        file,
        problem:
          "trustedDependencies is not set, so Bun runs the install scripts of every package on its own built-in trusted list",
        remedy: `set "trustedDependencies": [${policy.allow.map((n) => JSON.stringify(n)).join(", ")}], an empty list when the policy allows none`,
      },
    ];
  // JSON null is not the explicit list Bun requires: Bun rejects it.
  if (doc.trustedDependencies === null)
    return [
      {
        rule: RULE,
        file,
        problem: "trustedDependencies is null, not a list of package names",
        remedy: `set "trustedDependencies": [${policy.allow.map((n) => JSON.stringify(n)).join(", ")}], an empty list when the policy allows none`,
      },
    ];
  return listAgrees(
    doc.trustedDependencies,
    policy.allow,
    file,
    "trustedDependencies",
    "install-scripts.allow",
  );
}

/**
 * A key or value of an ini line as npm's ini parser (`unsafe` in npm/ini)
 * decodes it: one wrapped in matching quotes has its single quotes stripped
 * and is JSON-parsed, keeping the type JSON gives (`'[false]'` is a list,
 * `'4320'` a number) or the text as written when JSON cannot read it; any
 * other is cut at its first unescaped `;` or `#`.
 */
function iniUnsafe(raw: string): unknown {
  const text = raw.trim();
  const quoted = ['"', "'"].some((q) => text.startsWith(q) && text.endsWith(q));
  if (!quoted) return iniUncommented(text);
  const inner = text.startsWith("'") ? text.slice(1, -1) : text;
  try {
    return JSON.parse(inner) as unknown;
  } catch {
    return inner;
  }
}

/**
 * An unquoted ini string as npm reads it: cut at the first `;` or `#` not
 * escaped by a backslash, with `\\`, `\;` and `\#` unescaped and every other
 * backslash kept.
 */
function iniUncommented(text: string): string {
  const kept = /^(?:[^;#]|\\[\s\S]?)*/.exec(text)?.[0] ?? "";
  return kept.replace(/\\([;#])/g, "$1").trim();
}

/** npm's ini line: a section header, or a key with an optional `=` value. */
const INI_LINE = /^\[([^\]]*)\]\s*$|^([^=]+)(=(.*))?$/;

/** An .npmrc setting: its decoded value and how many lines assign it. */
type IniSetting = { value: unknown; lines: number };

/**
 * The settings of an .npmrc, keyed as written, built as npm's ini parser
 * (`decode` in npm/ini) builds them: its line pattern, comment rule and key
 * and value decoding; a value `true`, `false` or `null` read as that JSON
 * value, and a line without `=` as true; a later assignment replacing an
 * earlier one; and its lists, where a key ending in `[]` makes the setting a
 * list and every assignment to it, bracketed or not and before or after,
 * joins that list. A key spelled any way npm accepts is the key npm sets, and
 * its value has the type npm gives it.
 *
 * Three constructs are could-not-check and throw: a section header, whose
 * settings are not top-level ones; a key naming an environment variable,
 * which npm and pnpm expand into a key this gate cannot know; and a key with a
 * `.` whose value ends as an object or null, which decode's last step nests
 * into the setting its dotted prefix names, replacing that setting when it is
 * not already an object (`dangerously-allow-all-builds=false` followed by
 * `dangerously-allow-all-builds.extra='{}'` leaves it the truthy
 * `{extra: {}}`). A gate that skipped any of them would pass a grant it never
 * read.
 */
function iniDecode(text: string, file: string): Map<string, IniSetting> {
  const settings = new Map<string, IniSetting>();
  for (const line of text.split(/[\r\n]+/)) {
    const assignment = iniAssignment(line, file);
    if (assignment) iniAssign(settings, ...assignment);
  }
  for (const [key, { value }] of settings)
    if (key.includes(".") && typeof value === "object" && !Array.isArray(value))
      throw new Unreadable(
        `${file} has a key, ${key}, whose ${show(value)} value npm nests into the setting its dotted prefix names, which this gate does not read`,
      );
  return settings;
}

/** One .npmrc line as a key, its value and whether it makes a list. */
function iniAssignment(
  line: string,
  file: string,
): [key: string, value: unknown, list: boolean] | undefined {
  const match = /^\s*([;#]|$)/.test(line) ? null : INI_LINE.exec(line);
  if (!match) return undefined;
  if (match[1] !== undefined)
    throw new Unreadable(
      `${file} has a section, ${line.trim()}, whose settings this gate does not read`,
    );
  const raw = iniUnsafe(match[2] ?? "");
  const list = typeof raw === "string" && raw.length > 2 && raw.endsWith("[]");
  const key = String(list ? (raw as string).slice(0, -2) : raw);
  if (key === "__proto__") return undefined;
  if (key.includes("${"))
    throw new Unreadable(
      `${file} has a key, ${key}, that names an environment variable, so the setting it makes depends on the install environment`,
    );
  return [key, match[3] ? iniValue(iniUnsafe(match[4] ?? "")) : true, list];
}

/** A decoded value, with `true`, `false` and `null` read as JSON values. */
function iniValue(decoded: unknown): unknown {
  return typeof decoded === "string" && /^(?:true|false|null)$/.test(decoded)
    ? (JSON.parse(decoded) as unknown)
    : decoded;
}

/** One assignment, joining the key's list when it has or makes one. */
function iniAssign(
  settings: Map<string, IniSetting>,
  key: string,
  value: unknown,
  list: boolean,
): void {
  const before = settings.get(key);
  let current = before?.value;
  if (list && !Array.isArray(current)) current = before ? [current] : [];
  settings.set(key, {
    value: Array.isArray(current) ? [...current, value] : value,
    lines: (before?.lines ?? 0) + 1,
  });
}

/**
 * Checks an .npmrc's settings, each matched in kebab case, the spelling pnpm
 * also accepts in camel case. A setting made under two spellings is a finding,
 * since which one pnpm keeps is its own choice.
 */
function checkNpmrc(text: string, file: string, policy: Policy): Finding[] {
  const settings = [...iniDecode(text, file)];
  const named = (name: string) =>
    settings.filter(([key]) => npmrcKey(key) === name);
  return [
    ...npmrcSpellings(named, file),
    ...npmrcCooldown(named("minimum-release-age"), file, policy),
    ...listAgrees(
      named("minimum-release-age-exclude").at(-1)?.[1].value,
      policy.exempt,
      file,
      "minimum-release-age-exclude",
      "cooldown.exempt",
    ),
    ...npmrcGrants(settings, file),
  ];
}

type NpmrcSettings = [key: string, setting: IniSetting][];

/** A cooldown setting made under more than one spelling. */
function npmrcSpellings(
  named: (name: string) => NpmrcSettings,
  file: string,
): Finding[] {
  return ["minimum-release-age", "minimum-release-age-exclude"].flatMap(
    (name) => {
      const spellings = named(name);
      if (spellings.length < 2) return [];
      return [
        {
          rule: RULE,
          file,
          problem: `${name} is set under ${spellings.length} spellings (${spellings.map(([key]) => key).join(", ")})`,
          remedy: `keep only ${name}`,
        },
      ];
    },
  );
}

/** The cooldown, set once to the policy's days in minutes. */
function npmrcCooldown(
  ages: NpmrcSettings,
  file: string,
  policy: Policy,
): Finding[] {
  const want = policy.days * 1440;
  const findings: Finding[] = [];
  const lines = ages.reduce((n, [, setting]) => n + setting.lines, 0);
  if (lines > 1)
    findings.push({
      rule: RULE,
      file,
      problem: `minimum-release-age is set ${lines} times`,
      remedy: `set it once, to ${want} (minutes)`,
    });
  const age = ages.at(-1)?.[1].value;
  const agrees =
    (typeof age === "string" || typeof age === "number") &&
    String(age) === String(want);
  if (!agrees)
    findings.push({
      rule: RULE,
      file,
      problem: `minimum-release-age is ${show(age)}; the policy's cooldown is ${plural(policy.days, "day")} (${want} minutes)`,
      remedy: `set minimum-release-age=${want}`,
    });
  return findings;
}

/**
 * Every build grant: no allowlist is compared in .npmrc, and only the boolean
 * false disables dangerously-allow-all-builds.
 */
function npmrcGrants(settings: NpmrcSettings, file: string): Finding[] {
  return settings.flatMap(([key, { value }]) => {
    const name = npmrcKey(key);
    if (!NPMRC_GRANTS.has(name)) return [];
    if (name === "dangerously-allow-all-builds" && value === false) return [];
    return [
      {
        rule: RULE,
        file,
        problem: `${key} is set (${show(value)}), which grants install scripts outside pnpm-workspace.yaml's onlyBuiltDependencies`,
        remedy: `remove every ${key} line; state the allowlist as onlyBuiltDependencies in pnpm-workspace.yaml`,
      },
    ];
  });
}

/**
 * The pnpm settings other than onlyBuiltDependencies that can let a package
 * run install scripts, each with the values that grant nothing. The allowlist
 * is held in one place, so every other grant is refused rather than compared.
 */
const PNPM_GRANTS: [key: string, grants: (value: unknown) => boolean][] = [
  ["dangerouslyAllowAllBuilds", (v) => v !== false],
  ["neverBuiltDependencies", () => true],
  ["onlyBuiltDependenciesFile", () => true],
  [
    "allowBuilds",
    (v) =>
      !isRecord(v) || Object.values(v).some((allowed) => allowed !== false),
  ],
];

/** The .npmrc spelling of a pnpm setting, its key in kebab case. */
function npmrcKey(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** A pnpm build grant set in .npmrc, where no allowlist is compared. */
const NPMRC_GRANTS = new Set(
  ["onlyBuiltDependencies", ...PNPM_GRANTS.map(([key]) => key)].map(npmrcKey),
);

/** A YAML file's document; throw when it is not YAML. */
function yamlDocument(text: string, file: string): unknown {
  try {
    return loadYaml(text) as unknown;
  } catch (error) {
    throw new Unreadable(`${file} is not YAML: ${message(error)}`);
  }
}

function checkPnpmWorkspace(
  text: string,
  file: string,
  policy: Policy,
): Finding[] {
  const doc = yamlDocument(text, file);
  if (!isRecord(doc)) throw new Unreadable(`${file} is not a mapping`);
  const findings = listAgrees(
    doc.onlyBuiltDependencies,
    policy.allow,
    file,
    "onlyBuiltDependencies",
    "install-scripts.allow",
  );
  for (const [key, grants] of PNPM_GRANTS)
    if (doc[key] !== undefined && doc[key] !== null && grants(doc[key]))
      findings.push({
        rule: RULE,
        file,
        problem: `${key} is ${show(doc[key])}, which can let packages outside onlyBuiltDependencies run install scripts`,
        remedy: `remove ${key}; onlyBuiltDependencies is the allowlist`,
      });
  const want = policy.days * 1440;
  const age = doc.minimumReleaseAge;
  if (age !== want)
    findings.push({
      rule: RULE,
      file,
      problem: `minimumReleaseAge is ${show(age)}; the policy's cooldown is ${plural(policy.days, "day")} (${want} minutes)`,
      remedy: `set minimumReleaseAge: ${want}`,
    });
  findings.push(
    ...listAgrees(
      doc.minimumReleaseAgeExclude,
      policy.exempt,
      file,
      "minimumReleaseAgeExclude",
      "cooldown.exempt",
    ),
  );
  return findings;
}

/** The package rules of a parsed Renovate configuration, each a mapping. */
function packageRules(
  doc: Record<string, unknown>,
  file: string,
): Record<string, unknown>[] {
  const rules = doc.packageRules;
  if (rules === undefined) return [];
  if (!Array.isArray(rules) || !rules.every(isRecord))
    throw new Unreadable(`${file}: packageRules is not a list of rules`);
  return rules;
}

/**
 * A rule's selectors other than matchPackageNames. Renovate applies a rule
 * only where every selector matches, so each one narrows the packages or
 * updates the rule covers.
 */
function otherSelectors(rule: Record<string, unknown>): string[] {
  return Object.keys(rule).filter(
    (key) => /^(match|exclude)[A-Z]/.test(key) && key !== "matchPackageNames",
  );
}

/**
 * The findings for each rule's own cooldown, and the indexes of the rules
 * that set it to 0 (the exemptions).
 */
function cooldownRules(
  rules: Record<string, unknown>[],
  want: number,
  finding: Make,
): { exemptions: number[]; findings: Finding[] } {
  const exemptions: number[] = [];
  const findings: Finding[] = [];
  rules.forEach((rule, index) => {
    if (rule.minimumReleaseAge === undefined) return;
    const seconds = durationSeconds(rule.minimumReleaseAge);
    if (seconds === undefined)
      findings.push(
        finding(
          `packageRules[${index}] sets minimumReleaseAge to ${show(rule.minimumReleaseAge)}, which is not a duration`,
          'write it as "<n> days", or "0 days" for the policy\'s exemptions',
        ),
      );
    else if (seconds === 0) exemptions.push(index);
    else if (seconds < want)
      findings.push(
        finding(
          `packageRules[${index}] shortens the cooldown to ${show(rule.minimumReleaseAge)} for ${show(rule.matchPackageNames)}`,
          "remove the rule, or exempt those packages in the policy and set the rule to 0 days",
        ),
      );
  });
  return { exemptions, findings };
}

/**
 * The install-script guard: one rule with automerge: false naming the
 * policy's allowed packages, last in the list.
 */
function guardRules(
  rules: Record<string, unknown>[],
  policy: Policy,
  file: string,
  finding: Make,
): Finding[] {
  const findings: Finding[] = [];
  const guards = rules
    .map((rule, index) => ({ rule, index }))
    .filter(
      ({ rule }) =>
        rule.automerge === false && Array.isArray(rule.matchPackageNames),
    );
  if (guards.length !== 1)
    findings.push(
      finding(
        `${guards.length} packageRules set automerge: false for named packages; the install-script guard is one rule naming the policy's ${plural(policy.allow.length, "allowed package")}`,
        `keep one rule with matchPackageNames [${policy.allow.join(", ")}] and automerge: false, as the last packageRule`,
      ),
    );
  for (const { rule, index } of guards) {
    const narrowing = otherSelectors(rule);
    if (narrowing.length)
      findings.push(
        finding(
          `packageRules[${index}] (automerge: false for the install-script packages) also selects by ${narrowing.join(", ")}, so updates it does not select can still be auto-merged`,
          `remove ${narrowing.join(", ")}: the guard covers every update of those packages`,
        ),
      );
    findings.push(
      ...listAgrees(
        rule.matchPackageNames,
        policy.allow,
        file,
        `packageRules[${index}].matchPackageNames`,
        "install-scripts.allow",
      ),
    );
    if (index !== rules.length - 1)
      findings.push(
        finding(
          `packageRules[${index}] (automerge: false for the install-script packages) is followed by ${plural(rules.length - 1 - index, "rule")}; a later rule overrides it and can re-enable automerge for a package that runs scripts`,
          "move it to the end of packageRules",
        ),
      );
  }
  return findings;
}

/**
 * A rule setting the cooldown to 0 names exactly the policy's exemptions, and
 * selects by package name alone: without matchPackageNames it exempts every
 * package its other selectors match, and another selector would exempt only
 * some updates of the named packages.
 */
function exemptionRule(
  rule: Record<string, unknown>,
  index: number,
  policy: Policy,
  file: string,
): Finding[] {
  const where = `packageRules[${index}]`;
  const finding: Make = (problem, remedy) => ({
    rule: RULE,
    file,
    problem,
    remedy,
  });
  const names = rule.matchPackageNames;
  if (!Array.isArray(names) || names.length === 0)
    return [
      finding(
        `${where} sets minimumReleaseAge to 0 without naming packages in matchPackageNames, so it exempts every package it selects from the cooldown`,
        policy.exempt.length
          ? `select by matchPackageNames [${policy.exempt.join(", ")}] alone`
          : "remove the rule: the policy exempts no package",
      ),
    ];
  const narrowing = otherSelectors(rule);
  return [
    ...(narrowing.length
      ? [
          finding(
            `${where} (the cooldown exemption) also selects by ${narrowing.join(", ")}, which the policy's exemptions do not`,
            `remove ${narrowing.join(", ")}: an exemption covers every release of the packages it names`,
          ),
        ]
      : []),
    ...listAgrees(
      names,
      policy.exempt,
      file,
      `${where}.matchPackageNames`,
      "cooldown.exempt",
    ),
  ];
}

function checkRenovate(text: string, file: string, policy: Policy): Finding[] {
  let doc: unknown;
  try {
    doc = Bun.JSON5.parse(text);
  } catch (error) {
    throw new Unreadable(`${file} is not JSON5: ${message(error)}`);
  }
  if (!isRecord(doc)) throw new Unreadable(`${file} is not an object`);
  const finding: Make = (problem, remedy) => ({
    rule: RULE,
    file,
    problem,
    remedy,
  });
  const findings: Finding[] = [];
  const want = policy.days * SECONDS.day;
  const age = durationSeconds(doc.minimumReleaseAge);
  if (age !== want)
    findings.push(
      finding(
        `minimumReleaseAge is ${show(doc.minimumReleaseAge)}; the policy's cooldown is ${plural(policy.days, "day")}`,
        `set minimumReleaseAge: "${policy.days} days"`,
      ),
    );
  if (doc.internalChecksFilter !== "strict")
    findings.push(
      finding(
        `internalChecksFilter is ${show(doc.internalChecksFilter)}; without "strict" a branch and a green pull request exist before the cooldown has passed`,
        'set internalChecksFilter: "strict" explicitly, so a changed default cannot weaken it',
      ),
    );
  const rules = packageRules(doc, file);
  const cooldown = cooldownRules(rules, want, finding);
  findings.push(...cooldown.findings);
  const { exemptions } = cooldown;
  if (exemptions.length > 1)
    findings.push(
      finding(
        `${exemptions.length} packageRules set minimumReleaseAge to 0 (rules ${exemptions.join(", ")})`,
        "keep one rule naming every exempt package",
      ),
    );
  if (exemptions.length === 0 && policy.exempt.length > 0)
    findings.push(
      finding(
        `no packageRule sets minimumReleaseAge to 0 days, so the policy's ${plural(policy.exempt.length, "exempt package")} wait out the cooldown`,
        `add one rule with matchPackageNames [${policy.exempt.join(", ")}] and minimumReleaseAge: "0 days"`,
      ),
    );
  for (const index of exemptions)
    findings.push(...exemptionRule(rules[index] ?? {}, index, policy, file));
  if (policy.allow.length > 0)
    findings.push(...guardRules(rules, policy, file, finding));
  return findings;
}

/** One updates entry's cooldown against the policy. */
function entryCooldown(
  entry: Record<string, unknown>,
  where: string,
  policy: Policy,
  file: string,
  finding: Make,
): Finding[] {
  const findings: Finding[] = [];
  const cooldown = isRecord(entry.cooldown) ? entry.cooldown : {};
  if (cooldown["default-days"] !== policy.days)
    findings.push(
      finding(
        `${where}.cooldown.default-days is ${show(cooldown["default-days"])}; the policy's cooldown is ${plural(policy.days, "day")}`,
        `set cooldown.default-days: ${policy.days}`,
      ),
    );
  for (const key of [
    "semver-major-days",
    "semver-minor-days",
    "semver-patch-days",
  ]) {
    const value = cooldown[key];
    if (
      value !== undefined &&
      !(typeof value === "number" && value >= policy.days)
    )
      findings.push(
        finding(
          `${where}.cooldown.${key} is ${show(value)}, below the policy's ${plural(policy.days, "day")}`,
          `set it to ${policy.days} or more, or remove it`,
        ),
      );
  }
  if (cooldown.include !== undefined)
    findings.push(
      finding(
        `${where}.cooldown.include limits the cooldown to the packages it lists`,
        "remove include: the cooldown applies to every package but the policy's exemptions",
      ),
    );
  findings.push(
    ...listAgrees(
      cooldown.exclude,
      policy.exempt,
      file,
      `${where}.cooldown.exclude`,
      "cooldown.exempt",
    ),
  );
  return findings;
}

function checkDependabot(
  text: string,
  file: string,
  policy: Policy,
): Finding[] {
  const doc = yamlDocument(text, file);
  if (
    !isRecord(doc) ||
    !Array.isArray(doc.updates) ||
    !doc.updates.every(isRecord)
  )
    throw new Unreadable(`${file} has no updates list`);
  const finding: Make = (problem, remedy) => ({
    rule: RULE,
    file,
    problem,
    remedy,
  });
  const findings: Finding[] = [];
  const entries = doc.updates
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        entry["package-ecosystem"] === "npm" ||
        entry["package-ecosystem"] === "bun",
    );
  if (entries.length === 0)
    findings.push(
      finding(
        "no updates entry has package-ecosystem npm or bun, so the updater does not cover the application's dependencies",
        "add one, or do not name this file when another updater covers them",
      ),
    );
  for (const { entry, index } of entries)
    findings.push(
      ...entryCooldown(entry, `updates[${index}]`, policy, file, finding),
    );
  return findings;
}

export interface Options {
  policy: string;
  root: string;
  files: Partial<Record<Reader, string>>;
}

/** One `--name value` pair applied to the options. */
function setOption(options: Options, arg: string, value: string): void {
  const name = arg.slice(2);
  if (name === "policy") options.policy = value;
  else if (name === "root") options.root = value;
  else if ((READERS as readonly string[]).includes(name)) {
    const reader = name as Reader;
    if (options.files[reader] !== undefined)
      throw new Unreadable(`--${name} given twice\n${usage}`);
    options.files[reader] = value;
  } else throw new Unreadable(`unknown option ${arg}\n${usage}`);
}

export function parseArgs(args: string[]): Options {
  const options: Options = { policy: "", root: process.cwd(), files: {} };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const value = args[++i];
    if (!arg.startsWith("--") || value === undefined)
      throw new Unreadable(
        `${arg ? `${arg} needs a value` : "unexpected argument"}\n${usage}`,
      );
    setOption(options, arg, value);
  }
  if (!options.policy) throw new Unreadable(`--policy is required\n${usage}`);
  if (Object.keys(options.files).length === 0)
    throw new Unreadable(`no installer or updater file to check\n${usage}`);
  if (
    options.files.npmrc !== undefined &&
    options.files["pnpm-workspace"] === undefined
  )
    throw new Unreadable(
      `--npmrc needs --pnpm-workspace: pnpm reads its settings from pnpm-workspace.yaml, and a version that still reads .npmrc is checked in both\n${usage}`,
    );
  return options;
}

function read(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    throw new Unreadable(`cannot read ${what} ${path}: ${message(error)}`);
  }
}

/**
 * Every finding across the files given, and why each file that could not be
 * checked could not be. Each file is checked on its own, so one that cannot
 * be read neither hides another's findings nor stops it being read. Throw
 * only when the policy itself cannot be read.
 */
export function lockstep(options: Options): {
  policy: Policy;
  findings: Finding[];
  files: string[];
  errors: string[];
} {
  const policy = parsePolicy(read(options.policy, "policy"), options.policy);
  const findings: Finding[] = [];
  const files: string[] = [];
  const errors: string[] = [];
  const check = (
    reader: Reader,
    run: (text: string, file: string) => Finding[],
  ): void => {
    const path = options.files[reader];
    if (path === undefined) return;
    const file = repoPath(options.root, path);
    files.push(file);
    try {
      findings.push(...run(read(path, `--${reader}`), file));
    } catch (error) {
      errors.push(message(error));
    }
  };
  check("bunfig", (t, f) => checkBunfig(t, f, policy));
  check("package-json", (t, f) => checkPackageJson(t, f, policy));
  check("npmrc", (t, f) => checkNpmrc(t, f, policy));
  check("pnpm-workspace", (t, f) => checkPnpmWorkspace(t, f, policy));
  check("renovate", (t, f) => checkRenovate(t, f, policy));
  check("dependabot", (t, f) => checkDependabot(t, f, policy));
  return { policy, findings, files, errors };
}

export function main(args = process.argv.slice(2)): number {
  let result: ReturnType<typeof lockstep>;
  let options: Options;
  try {
    options = parseArgs(args);
    result = lockstep(options);
  } catch (error) {
    return couldNotCheck(RULE, message(error));
  }
  const { policy, findings, files, errors } = result;
  for (const error of errors) couldNotCheck(RULE, error);
  // A known violation outranks a file that could not be checked.
  if (findings.length) {
    reportFindings(findings);
    console.error(
      `${RULE}: ${plural(findings.length, "finding")} across ${files.join(", ")}; the policy is ${repoPath(options.root, options.policy)}`,
    );
    return 1;
  }
  if (errors.length) return 2;
  const guard =
    options.files.renovate !== undefined && policy.allow.length === 0
      ? "; the install-script guard rule is not required while the allowlist is empty"
      : "";
  console.log(
    `${RULE}: OK — ${files.length} file(s) state the policy in ${repoPath(options.root, options.policy)}: cooldown ${plural(policy.days, "day")}, ${plural(policy.exempt.length, "exemption")}, ${plural(policy.allow.length, "package")} allowed to run install scripts (${files.join(", ")}). Checks those values only; files not given, and whether the updater runs, are not checked${guard}`,
  );
  return 0;
}

if (import.meta.main) cli(() => main());
