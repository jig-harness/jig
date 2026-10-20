/** Keep prescribed skill commands executable as plain argv in Bash and PowerShell. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { walk } from "../lib/files.ts";
import {
  couldNotCheck,
  type Finding,
  repoPath,
  reportFindings,
} from "../lib/findings.ts";

const RULE = "skill-shell-neutrality";
const SHELL_LANGUAGES = new Set([
  "bash",
  "sh",
  "shell",
  "powershell",
  "pwsh",
  "console",
]);

/** Template fields are filled by the agent before execution, never shell redirections. */
function withoutPlaceholders(command: string): string {
  return command
    .replace(/<[A-Za-z][^<>\n]*>/g, "ARG")
    .replaceAll(/\$\{CLAUDE_SKILL_DIR\}/g, "SKILL_DIR");
}

type Quote = "'" | '"';
interface ScanState {
  quote: Quote | null;
}
const COMMENT = Symbol("comment");
const INTERPOLATION = new Set(["$", "`"]);
const UNQUOTED_PROBLEMS: Record<string, string> = {
  "|": "shell operators must move into the script they feed",
  "&": "shell operators must move into the script they feed",
  ";": "shell operators must move into the script they feed",
  "<": "shell operators must move into the script they feed",
  ">": "shell operators must move into the script they feed",
  "\\": "unquoted shell escapes are not portable",
  "*": "wildcard arguments must be quoted",
  "?": "wildcard arguments must be quoted",
  "{": "brace arguments must be quoted for consistent shell parsing",
  "}": "brace arguments must be quoted for consistent shell parsing",
  $: "shell interpolation is not a plain argument",
  "`": "shell interpolation is not a plain argument",
};

function quotedProblem(
  command: string,
  index: number,
  state: ScanState,
): string | null {
  const c = command[index];
  if (c === state.quote) {
    if (c === "'" && command[index + 1] === "'")
      return "adjacent single quotes have different shell meanings";
    state.quote = null;
  } else if (state.quote === '"' && INTERPOLATION.has(c ?? ""))
    return "shell interpolation is not a plain argument";
  return null;
}

function scanCharacter(
  command: string,
  index: number,
  state: ScanState,
): string | typeof COMMENT | null {
  if (state.quote !== null) return quotedProblem(command, index, state);
  const c = command[index] ?? "";
  const problem = UNQUOTED_PROBLEMS[c];
  if (problem) return problem;
  if (c === "#" && /\s/.test(command[index - 1] ?? " ")) return COMMENT;
  if (c === "'" || c === '"') state.quote = c;
  return null;
}

function commandProblem(raw: string): string | null {
  const command = withoutPlaceholders(raw.trim());
  if (!command || command.startsWith("#")) return null;
  if (!/^bun(?:\s|$)/.test(command))
    return "executable examples must start with bun";
  const state: ScanState = { quote: null };
  for (let index = 0; index < command.length; index++) {
    const problem = scanCharacter(command, index, state);
    if (problem === COMMENT) break;
    if (problem !== null) return problem;
  }
  return state.quote === null ? null : "unclosed argument quote";
}

interface DocumentState {
  fence: string | null;
  executable: boolean;
}
function updateFence(marker: RegExpExecArray, state: DocumentState): void {
  if (state.fence === null) {
    state.fence = marker[1] as string;
    state.executable = SHELL_LANGUAGES.has(marker[2] ?? "");
  } else if (marker[1]?.startsWith(state.fence)) {
    state.fence = null;
    state.executable = false;
  }
}

function inlineCommands(source: string): { command: string; line: number }[] {
  const programs =
    /^(?:bun|git|gh|echo|cat|test|mktemp|set|export|eval|ln|rm|touch|tail|grep|mkdir|command|printf|curl|pwd|cp|mv|sed|sort|env|head|xargs|find|jq|read)\s/;
  const scripts = /^(?:[\w./<>-]+\/)?[\w-]+\.ts\s/;
  const substitution = /\$\((?:bun|git|gh)\b/;
  return [...source.matchAll(/`([^`]+)`/g)]
    .map((match) => ({
      command: (match[1] as string).replace(/\s+/g, " ").trim(),
      line: source.slice(0, match.index).split("\n").length,
    }))
    .filter(
      ({ command }) =>
        programs.test(command) ||
        scripts.test(command) ||
        substitution.test(command),
    )
    .map(({ command, line }) => ({ command: normalizeInline(command), line }));
}

function normalizeInline(command: string): string {
  // Bare tool/operation names can describe behavior. A snippet with options,
  // paths or other arguments is an executable recipe and must name Bun.
  const name = /^(?:git [a-z][a-z-]*|gh (?:api|[a-z-]+ [a-z-]+))$/;
  return name.test(command) ? `bun ${command}` : command;
}

function lineCommands(
  raw: string,
  state: DocumentState,
): { commands: string[]; prose: string } {
  const line = raw.replace(/^\s*(?:>\s*)+/, "");
  const marker = /^\s*(`{3,}|~{3,})(\S*)/.exec(line);
  if (marker) {
    updateFence(marker, state);
    return { commands: [], prose: "" };
  }
  if (state.fence !== null)
    return { commands: state.executable ? [line] : [], prose: "" };
  return { commands: [], prose: line };
}

function commandFindings(
  command: string,
  file: string,
  line: number,
): Finding[] {
  const problem = commandProblem(command);
  return problem
    ? [
        {
          rule: RULE,
          file,
          line,
          problem,
          remedy:
            "use a single-line bun invocation with plain arguments; read generated text from a file and perform composition inside a Bun script",
        },
      ]
    : [];
}

export function shellFindings(file: string, source: string): Finding[] {
  const state: DocumentState = { fence: null, executable: false };
  const parsed = source.split(/\r?\n/).map((line) => lineCommands(line, state));
  const fenced = parsed.flatMap(({ commands }, index) =>
    commands.flatMap((command) => commandFindings(command, file, index + 1)),
  );
  const prose = parsed.map(({ prose }) => prose).join("\n");
  return [
    ...fenced,
    ...inlineCommands(prose).flatMap(({ command, line }) =>
      commandFindings(command, file, line),
    ),
  ];
}

export function checkSkillShellNeutrality(root = "."): number {
  try {
    const base = join(root, "plugin", "skills");
    const files = walk(base, ["__tests__", "fixtures", "templates"]).filter(
      (file) => file.endsWith(".md"),
    );
    if (!files.length)
      return couldNotCheck(RULE, "no skill instruction documents found");
    const findings = files.flatMap((file) =>
      shellFindings(
        repoPath(root, join(base, file)),
        readFileSync(join(base, file), "utf8"),
      ),
    );
    if (findings.length) {
      reportFindings(findings);
      return 1;
    }
    console.log(
      `${RULE}: OK — skill commands use single-line bun invocations with plain arguments`,
    );
    return 0;
  } catch (error) {
    return couldNotCheck(
      RULE,
      error instanceof Error ? error.message : String(error),
    );
  }
}

if (import.meta.main) cli(() => checkSkillShellNeutrality(process.argv[2]));
