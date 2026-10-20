// The plugin reaches the issue tracker only through the tracker interface:
// the adapters in `plugin/skills/do-item/scripts/lib/tracker/`, called
// through the `Tracker` port or `do-item/scripts/tracker.ts`. Anything else
// that calls Linear directly is code a second tracker's adapter cannot reach.
//
// "Directly" means a token only a direct call uses: Linear's API host, its
// SDK package, the name prefix of a Linear MCP server's tools, or a run of
// the `linear` command-line client. A run is one of: an argument list whose
// first element is the literal `linear`; a call whose first argument is
// `linear` and whose second is an argument list written out; a call to a
// process launcher (`LAUNCHERS`, `QUALIFIED` and `PYTHON_LAUNCHERS` below)
// on any receiver, or to a name the file binds to one, with `linear` (or an
// argument list starting with it) where that launcher takes its program: the
// first argument, and for a launcher taking a mode first (`MODE_FIRST`:
// `os.spawnlp(os.P_WAIT, "linear", …)`) the second, after a mode written as
// any expression (`MODE`); or a command line
// `linear <subcommand>`. Grouping parentheses around a launcher
// (`(cp.spawnSync)`) keep it one. `linear` anywhere else in a launcher's
// arguments (`spawnSync("echo", ["linear"])`) is data for another program,
// and a call to any other function with `linear` first
// (`console.log("linear", v)`) names the client without running it.
//
// This is a text check, not a parser, and what it guarantees is stated in
// terms of those forms. Runs are looked for in the file's text as written,
// with any comment or continued line between two tokens read as white space,
// in a run, in a Python import list and in the bindings that name a launcher
// alike: no comment hides one of these forms, and a run written inside a
// comment's prose is reported like one in the code. Nothing is lexed, so no
// string, regular expression or template the check reads wrongly can blank
// code out of its view. Only gaps are read between a launcher's opening
// parenthesis and its program, so what a comment there holds, parentheses
// included, cannot shift the program's position. The file is matched as a
// whole, so an argument list or a spawn split over several lines is found
// like one written on a single line; a command line stays on one line. A
// launcher missing from the lists, or a program name the code assembles at
// run time, is not seen: a new launcher is added to its list.
//
// Scope: every code file (TypeScript, JavaScript, shell, Python) under
// `plugin/` outside the adapters' directory, and every file of the planning
// skills (`file-issue`, `work-batch`), whose procedures must name the
// interface's commands rather than a tracker's tools. Tests (`__tests__/`) are out of scope: the plugin ships without
// them, and they exercise the adapters through fakes. The other skills'
// `SKILL.md` files and references are out of scope for now: they name the
// Linear MCP tools as the harness's own fallback for the operations their
// scripts do not cover.
//
// The allow list (`tracker-boundary-allow.txt` beside this script) names a
// file that still bypasses the interface, one path per line under `#` lines
// giving the reason. An entry without a reason, or one whose file no longer
// reaches Linear directly, is itself a finding, so the list only shrinks.
//
// Exit 1 on a finding, 2 when it cannot check: no `plugin/` directory, the
// allow list missing, or a file in scope unreadable.
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { readRegularFile, repoFiles } from "../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  type ReasonedEntry,
  reasonedEntries,
  reportFindings,
} from "../lib/findings.ts";

const RULE = "tracker-boundary";
const ALLOW_RULE = "tracker-boundary-allowlist";
const ALLOW_FILE = "scripts/tracker-boundary-allow.txt";

/** The adapters' directory: the one place that may reach Linear directly. */
export const ADAPTERS = "plugin/skills/do-item/scripts/lib/tracker/";

/** The skills whose every file is checked, documents included. */
export const PLANNING_SKILLS = [
  "plugin/skills/file-issue/",
  "plugin/skills/work-batch/",
];

/** Code in any language the plugin's scripts are written in. */
const CODE = /\.(?:[cm]?ts|[cm]?js|sh|bash|py)$/;

/** The tokens only a direct call to Linear uses, each with what it names. */
export const TOKENS: { what: string; pattern: RegExp }[] = [
  { what: "Linear's API host", pattern: /api\.linear\.app/i },
  { what: "Linear's SDK package", pattern: /@linear\/sdk/ },
  // An MCP tool's name is `mcp__<server>__<tool>`, and the server's name is
  // whatever the harness or the plugin that registered it chose
  // (`mcp__linear__…`, `mcp__claude_ai_Linear__…`), so any server segment
  // naming Linear counts.
  {
    what: "a Linear MCP tool",
    pattern: /mcp__(?:(?!__)[\w-])*linear(?:(?!__)[\w-])*__/i,
  },
];

/** What a run of the `linear` command-line client is reported as. */
const RUN = "a run of the `linear` command-line client";

/** The literal `linear` in any of the three quotes. */
const LINEAR = String.raw`["'\`]linear["'\`]`;

/** Functions that start a process from a program name and its arguments. */
const LAUNCHERS = [
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "exec",
  "execSync",
  "fork",
  "execa",
  "execaSync",
  "Popen",
  "check_call",
  "check_output",
];

/**
 * The Python modules that start a process, each with the pattern of the
 * names it exports that do: a run through `module.name`, through a name
 * `from module import …` binds, or through `import module as m`'s `m`.
 */
const PYTHON_LAUNCHERS: Record<string, string> = {
  subprocess: "run|call|Popen|check_call|check_output",
  asyncio: "create_subprocess_(?:exec|shell)",
  os: "exec[lv]p?e?|posix_spawnp?",
};

/** The Python launchers that take a mode before their program, by module. */
const MODE_FIRST: Record<string, string> = { os: "spawn[lv]p?e?" };

/**
 * What may stand between two of a run's tokens: white space, a comment in
 * any of the languages' syntaxes, and a backslash ending a line (a continued
 * line in Python and shell). A comment cannot end early (a line comment runs
 * to its line's end, a block comment to its first closing marker), so a gap
 * matches in one way only and a scan stays linear in the file's length.
 * Every pattern below separates its tokens with `GAP` (or `GAP1` where they
 * must be separated) and never with bare white space.
 */
const SPACE = String.raw`(?:\s|\/\*(?:[^*]|\*(?!\/))*\*\/|\/\/[^\n]*(?![^\n])|#[^\n]*(?![^\n])|\\\r?\n)`;
const GAP = `${SPACE}*`;
const GAP1 = `${SPACE}+`;
const DOT = String.raw`${GAP}\.${GAP}`;
/** A gap that stays on its line: a Python statement ends at a bare line break. */
const LINE_GAP = String.raw`(?:[ \t\f\v\r]|#[^\n]*(?![^\n])|\\\r?\n)*`;

/** `module.name` for each of a table's modules and the names it exports. */
const qualifiedIn = (table: Record<string, string>) =>
  Object.entries(table).map(
    ([module, names]) => String.raw`${module}${DOT}(?:${names})`,
  );

/** Launchers whose name means one only on their own module. */
const QUALIFIED = [
  String.raw`Bun${DOT}spawn(?:Sync)?`,
  String.raw`Deno${DOT}Command`,
  ...qualifiedIn(PYTHON_LAUNCHERS),
];

const IDENT = String.raw`[A-Za-z_$][\w$]*`;
/**
 * A launcher's receiver: a chain of names, each optionally called with
 * arguments on one line (`this.cp.`, `require("node:child_process").`).
 * Each link is a name and a dot, so the chain cannot be read two ways that
 * cost more than its length.
 */
const RECEIVER = String.raw`(?:${IDENT}(?:${GAP}\([^()\n]*\))?${DOT})*`;
/** White space, a comment or a continued line, in Python (the one language a mode-first launcher is in). */
const PY_SPACE = String.raw`(?:\s|#[^\n]*(?![^\n])|\\\r?\n)`;
/** A one-line Python string literal. */
const PY_STRING = String.raw`(?:'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")`;
/**
 * Any part of a Python expression, its brackets nested `depth` deep: a
 * character outside brackets, strings and gaps (a comma too, inside
 * brackets), a gap, a string, or a bracketed group. Each part starts with a
 * character no other part starts with, so an expression is read one way only.
 */
const pyPart = (depth: number, comma: boolean): string => {
  const plain = String.raw`[^\s#\\'"()[\]{}${comma ? "" : ","}]`;
  const inner = depth ? `${pyPart(depth - 1, true)}*` : "";
  const groups = depth
    ? [
        String.raw`\(${inner}\)`,
        String.raw`\[${inner}\]`,
        String.raw`\{${inner}\}`,
      ]
    : [];
  return `(?:${[plain, PY_SPACE, PY_STRING, ...groups].join("|")})`;
};
/**
 * A launcher's mode argument: any one argument expression, read up to the
 * comma that ends it (`os.P_WAIT`, `(os.P_WAIT)`, `int(0)`, `modes[0]`,
 * `a if b else c`), with brackets nested up to 4 deep. It starts with
 * something other than a gap, which the call before it has read.
 */
const MODE = `(?!${PY_SPACE})${pyPart(4, false)}+`;
/** The program where a launcher takes it: the literal, or a list starting with it. */
const PROGRAM = String.raw`(?:\[${GAP})?${LINEAR}`;
const quoteName = (name: string) => name.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

/** One item of a Python import list: a dotted name, optionally `as` an alias. */
const ITEM = String.raw`[\w.]+(?:${GAP1}as${GAP1}${IDENT})?`;

/**
 * A Python import list, parenthesised (over any lines) or not (on one line
 * and its continued lines), with any comment between two of its tokens.
 */
const IMPORT_LIST = String.raw`(?:\(${GAP}${ITEM}(?:${GAP},${GAP}${ITEM})*(?:${GAP},)?${GAP}\)|${ITEM}(?:${LINE_GAP},${LINE_GAP}${ITEM})*)`;

/** The `[name, alias]` pairs of an import list, its comments read as white space. */
function importItems(list: string): [string, string | undefined][] {
  return list
    .replace(new RegExp(SPACE, "g"), " ")
    .replace(/[()]/g, " ")
    .split(",")
    .flatMap((item) => {
      const [, name, alias] =
        /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(item) ?? [];
      return name ? [[name, alias] as [string, string | undefined]] : [];
    });
}

/** The names `from module import …` binds to one of a table's launchers, under their alias where they have one. */
function fromImports(code: string, table: Record<string, string>): string[] {
  const names: string[] = [];
  const from = new RegExp(
    String.raw`(?<![\w$.])from${GAP1}([\w.]+)${GAP1}import${GAP}(${IMPORT_LIST})`,
    "g",
  );
  for (const m of code.matchAll(from)) {
    const launchers = Object.hasOwn(table, m[1] as string)
      ? table[m[1] as string]
      : undefined;
    if (!launchers) continue;
    const launcher = new RegExp(`^(?:${launchers})$`);
    for (const [name, alias] of importItems(m[2] as string))
      if (launcher.test(name)) names.push(alias ?? name);
  }
  return names;
}

/** The modules of a table `import a, module as m` names, as `[m, the pattern of its launchers]`. */
function moduleAliases(
  code: string,
  table: Record<string, string>,
): [string, string][] {
  const modules: [string, string][] = [];
  const plain = new RegExp(
    String.raw`(?<![\w$.])import${GAP1}(${IMPORT_LIST})`,
    "g",
  );
  for (const m of code.matchAll(plain))
    for (const [name, alias] of importItems(m[1] as string)) {
      const launchers = Object.hasOwn(table, name) ? table[name] : undefined;
      if (launchers && alias) modules.push([alias, launchers]);
    }
  return modules;
}

/**
 * The names a file binds to a launcher: `import { execFileSync as run }`,
 * `const { spawnSync: run } = …`, `const run = cp.spawnSync` (on any
 * receiver: `this.cp.spawnSync`, `require(…).spawnSync`, and in grouping
 * parentheses: `(cp.spawnSync)`),
 * `from subprocess import run` or `… import (call, run as r)`, and
 * `import subprocess as sp`'s module name; followed
 * through a chain of such bindings.
 */
function launcherNames(
  code: string,
  base: string[],
  table: Record<string, string>,
  qualifiedNames: string[],
): string {
  const names = new Set(base);
  for (const name of fromImports(code, table)) names.add(name);
  const known = () => [...names].map(quoteName).join("|");
  const qualified = () =>
    [
      ...qualifiedNames,
      ...(names.size ? [String.raw`(?:${IDENT}${DOT})?(?:${known()})`] : []),
    ].join("|");
  for (let size = -1; size !== names.size; ) {
    size = names.size;
    for (const pattern of [
      ...(names.size
        ? [
            String.raw`(?<![\w$])(?:${known()})${GAP1}as${GAP1}(${IDENT})`,
            String.raw`(?<![\w$.])(?:${known()})${GAP}:${GAP}(${IDENT})`,
          ]
        : []),
      String.raw`\b(?:const|let|var)${GAP1}(${IDENT})${GAP}=${GAP}(?:\(${GAP})*${RECEIVER}(?:${qualified()})(?:${GAP}\))*(?![\w$]|${GAP}[().])`,
    ])
      for (const m of code.matchAll(new RegExp(pattern, "g")))
        names.add(m[1] as string);
  }
  return [
    qualified(),
    ...moduleAliases(code, table).map(
      ([m, launchers]) => String.raw`${quoteName(m)}${DOT}(?:${launchers})`,
    ),
  ].join("|");
}

/** The pattern of a run of the `linear` client in a file's text. */
function runPattern(code: string): RegExp {
  const launcher = launcherNames(code, LAUNCHERS, PYTHON_LAUNCHERS, QUALIFIED);
  const modeFirst = launcherNames(
    code,
    [],
    MODE_FIRST,
    qualifiedIn(MODE_FIRST),
  );
  /** A call to one of `launchers`, through any grouping, up to its first argument. */
  const call = (launchers: string) =>
    String.raw`(?<![\w$])(?:new${GAP1})?(?:${launchers})(?:${GAP}\))*${GAP}\(${GAP}`;
  return new RegExp(
    [
      String.raw`\[${GAP}${LINEAR}${GAP},`,
      String.raw`\(${GAP}${LINEAR}${GAP},${GAP}\[`,
      `${call(launcher)}${PROGRAM}`,
      `${call(modeFirst)}${MODE},${GAP}${PROGRAM}`,
      String.raw`(?<![\w./-])linear[ \t]+(?:api|auth|config|issues?|teams?|projects?|labels?|cycles?|comments?|documents?|milestones?|initiatives?)\b`,
    ].join("|"),
    "g",
  );
}

/** Whether the boundary applies to a repository path. */
export function inScope(path: string): boolean {
  if (!path.startsWith("plugin/") || path.startsWith(ADAPTERS)) return false;
  if (path.split("/").includes("__tests__")) return false;
  return CODE.test(path) || PLANNING_SKILLS.some((p) => path.startsWith(p));
}

/**
 * Every place in a file that holds a token, one finding per token and line;
 * a construct over several lines is reported at the line it starts on.
 */
export function violations(path: string, text: string): Finding[] {
  const findings: { line: number; order: number; finding: Finding }[] = [];
  const tokens = [
    ...TOKENS.map((t) => ({
      ...t,
      pattern: new RegExp(t.pattern, `${t.pattern.flags}g`),
    })),
    { what: RUN, pattern: runPattern(text) },
  ];
  tokens.forEach((token, order) => {
    const lines = new Set<number>();
    for (const match of text.matchAll(token.pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      if (lines.has(line)) continue;
      lines.add(line);
      findings.push({
        line,
        order,
        finding: {
          rule: RULE,
          file: path,
          line,
          problem: `names ${token.what}, reaching Linear outside the tracker interface`,
          remedy: `go through the Tracker port or do-item/scripts/tracker.ts (add the operation to ${ADAPTERS}port.ts and its adapters if it is missing); a procedure names the interface's command, not a tracker's tool`,
        },
      });
    }
  });
  return findings
    .sort((a, b) => a.line - b.line || a.order - b.order)
    .map((f) => f.finding);
}

/**
 * The findings left once the allow list is applied, and the allow list's
 * own findings: an entry without a reason, repeated, or allowing a file that
 * no longer reaches Linear directly.
 */
export function applyAllowList(
  found: Finding[],
  allow: ReasonedEntry[],
  allowFile = ALLOW_FILE,
): Finding[] {
  const allowed = new Set<string>();
  const own: Finding[] = [];
  for (const entry of allow) {
    const path = entry.text.trim();
    const at = { rule: ALLOW_RULE, file: allowFile, line: entry.line };
    if (allowed.has(path)) {
      own.push({
        ...at,
        problem: `${path} is listed twice`,
        remedy: "remove the repeated entry",
      });
      continue;
    }
    allowed.add(path);
    if (!entry.reason)
      own.push({
        ...at,
        problem: `${path} is allowed without a reason`,
        remedy:
          "put a `#` line above it saying why the file still bypasses the tracker interface and which open work moves it",
      });
    if (!found.some((f) => f.file === path))
      own.push({
        ...at,
        problem: `${path} no longer reaches Linear directly (or is out of the boundary's scope)`,
        remedy: "remove the entry: the list only shrinks",
      });
  }
  return [
    ...found.filter((f) => f.file === undefined || !allowed.has(f.file)),
    ...own,
  ];
}

export function checkTrackerBoundary(root = "."): number {
  if (
    !existsSync(join(root, "plugin")) ||
    !statSync(join(root, "plugin")).isDirectory()
  )
    return couldNotCheck(RULE, `no plugin/ directory under ${root}`);
  if (!existsSync(join(root, ALLOW_FILE)))
    return couldNotCheck(RULE, `${ALLOW_FILE} is missing under ${root}`);
  const reason = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  let allow: ReasonedEntry[];
  let paths: string[];
  try {
    allow = reasonedEntries(readRegularFile(join(root, ALLOW_FILE)));
    paths = repoFiles(root).filter(inScope);
  } catch (error) {
    return couldNotCheck(RULE, reason(error));
  }
  const found: Finding[] = [];
  let checked = 0;
  for (const path of paths) {
    let text: string;
    try {
      text = readRegularFile(join(root, path));
    } catch (error) {
      return couldNotCheck(RULE, `${path}: ${reason(error)}`);
    }
    found.push(...violations(path, text));
    checked++;
  }
  if (checked === 0)
    return couldNotCheck(
      RULE,
      `no file under plugin/ is in scope under ${root}`,
    );
  const findings = applyAllowList(found, allow);
  if (findings.length) {
    reportFindings(findings);
    return 1;
  }
  console.log(
    `${RULE}: OK — ${checked} plugin files reach Linear only through ${ADAPTERS}, apart from the ${allow.length} allowed`,
  );
  return 0;
}
if (import.meta.main) cli(() => checkTrackerBoundary(process.argv[2]));
