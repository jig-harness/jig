/**
 * The `code_stats` section of the repository's configuration, validated:
 * the ordered area rules (or the defaults), the default area, the kind
 * globs checked before built-in detection, the module globs and the
 * classify command. Every refusal names the field at fault.
 */
import { isRecord } from "../../../../shared/guards.ts";
import { BUILD_TOOLS } from "./build-tools.ts";
import { DATABASE_TOOLS } from "./database-tools.ts";
import type { ToolRule } from "./tool-rules.ts";
import { CodeStatsError } from "./errors.ts";
import { isKind, type Kind } from "./model.ts";

/** The area a file no rule matches falls into, unless configured. */
export const DEFAULT_AREA = "production";

/** The fields of `code_stats`; any other key is refused. */
export const FIELDS = [
  "areas",
  "default_area",
  "kinds",
  "modules",
  "classify_command",
] as const;

const AREA_KEYS = ["name", "description", "paths", "content"];

export interface Pattern {
  pattern: string;
  glob: Bun.Glob;
  /** What the glob stands for, where it is not the area's own (`build tool: Cargo`). */
  label?: string;
}

export interface AreaRule {
  name: string;
  description: string;
  patterns: Pattern[];
  /** YAML, JSON and other configuration files here are data. */
  content: boolean;
  /** Paths this area never takes, though its globs match them. */
  exclude?: Pattern[];
  /** A rule that is not a glob (the default `repo-config` area's). */
  predicate?: {
    test: (path: string, code: boolean) => boolean;
    rule: string;
  };
}

export interface KindRule {
  kind: Kind;
  pattern: Pattern;
}

export interface CodeStatsConfig {
  /** Whether `areas` came from the configuration (else the defaults). */
  configuredAreas: boolean;
  areas: AreaRule[];
  defaultArea: string;
  defaultAreaDescription: string;
  kinds: KindRule[];
  modules: Pattern[] | null;
  classifyCommand: string | null;
}

const GLOB_RULES: readonly [(pattern: string) => boolean, string][] = [
  [(p) => p.trim() === "", "is empty"],
  [(p) => p.includes("\0"), "holds a NUL character"],
  [
    (p) => p.startsWith("/"),
    "is absolute; globs are relative to the repository root",
  ],
  [
    (p) => p.split("/").includes(".."),
    "has a .. segment; globs stay inside the repository",
  ],
  [(p) => /(^|[^\\])(\\\\)*\\$/.test(p), "ends with a lone backslash"],
];

/** What is wrong with a glob's brackets and braces, or null. */
function bracketProblem(pattern: string): string | null {
  const bare = pattern.replace(/\\./g, "").replace(/\[[^\]]*\]/g, "");
  if (bare.includes("[")) return "opens a [ it never closes";
  let depth = 0;
  for (const c of bare) {
    depth += c === "{" ? 1 : c === "}" ? -1 : 0;
    if (depth < 0) return "closes a { it never opened";
  }
  return depth > 0 ? "opens a { it never closes" : null;
}

/** What is wrong with a glob, or null. Globs are relative to the root. */
export function globProblem(pattern: string): string | null {
  return (
    GLOB_RULES.find(([bad]) => bad(pattern))?.[1] ?? bracketProblem(pattern)
  );
}

function compile(pattern: string): Pattern {
  return { pattern, glob: new Bun.Glob(pattern) };
}

function patternList(value: unknown, field: string): Pattern[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new CodeStatsError(`${field} must be a nonempty list of globs`);
  return value.map((entry, i) => {
    if (typeof entry !== "string")
      throw new CodeStatsError(`${field}[${i}] must be a glob (text)`);
    const problem = globProblem(entry);
    if (problem)
      throw new CodeStatsError(
        `${field}[${i}] ${JSON.stringify(entry)} ${problem}`,
      );
    return compile(entry);
  });
}

function areaName(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new CodeStatsError(`${field} must be a nonempty name`);
  if (value !== value.trim() || value.includes("/"))
    throw new CodeStatsError(
      `${field} ${JSON.stringify(value)} must not hold a / or surrounding spaces`,
    );
  return value;
}

function parseArea(entry: unknown, i: number): AreaRule {
  const field = `code_stats.areas[${i}]`;
  if (!isRecord(entry))
    throw new CodeStatsError(`${field} must be a mapping with name and paths`);
  for (const key of Object.keys(entry))
    if (!AREA_KEYS.includes(key))
      throw new CodeStatsError(
        `${field} has unknown key ${key} (known: ${AREA_KEYS.join(", ")})`,
      );
  const description = entry.description ?? "";
  if (typeof description !== "string")
    throw new CodeStatsError(`${field}.description must be text`);
  const content = entry.content ?? false;
  if (typeof content !== "boolean")
    throw new CodeStatsError(`${field}.content must be true or false`);
  return {
    name: areaName(entry.name, `${field}.name`),
    description,
    patterns: patternList(entry.paths, `${field}.paths`),
    content,
  };
}

function parseAreas(value: unknown): AreaRule[] {
  if (!Array.isArray(value))
    throw new CodeStatsError(
      "code_stats.areas must be a list of {name, paths} rules",
    );
  const areas = value.map(parseArea);
  const seen = new Set<string>();
  for (const [i, area] of areas.entries()) {
    if (seen.has(area.name))
      throw new CodeStatsError(
        `code_stats.areas[${i}].name ${JSON.stringify(area.name)} repeats an earlier area`,
      );
    seen.add(area.name);
  }
  return areas;
}

function parseKinds(value: unknown): KindRule[] {
  if (!isRecord(value))
    throw new CodeStatsError(
      "code_stats.kinds must be a mapping of kind to a list of globs",
    );
  const rules: KindRule[] = [];
  for (const [kind, globs] of Object.entries(value)) {
    if (!isKind(kind))
      throw new CodeStatsError(
        `code_stats.kinds has unknown kind ${JSON.stringify(kind)} (known: code, test, docs, config, data, generated, fixture, asset, vendored, other)`,
      );
    for (const pattern of patternList(globs, `code_stats.kinds.${kind}`))
      rules.push({ kind, pattern });
  }
  return rules;
}

/** A root-level file that is not code (or test code) by its kind. */
function isRootNonCode(path: string, code: boolean): boolean {
  return !path.includes("/") && !code;
}

/** One default area, as data: the README and CONFIGURATION.md list these. */
export interface DefaultAreaSpec {
  name: string;
  description: string;
  paths: readonly string[];
  /** A tool table whose rows' globs the area takes, and what to call a row. */
  tools?: { label: string; rows: readonly ToolRule[] };
  /** Paths the area never takes, though its globs match them. */
  exclude?: readonly string[];
  /** Matched after `paths`: a rule globs cannot state. */
  predicate?: {
    test: (path: string, code: boolean) => boolean;
    rule: string;
  };
}

/**
 * The areas a repository without `code_stats.areas` gets. First match wins,
 * so specific rules come before broad ones: agent files in `.github/` are
 * scaffolding before `ci` takes the workflows; a Makefile under `tools/` is
 * build, and `tools/db/migrations/` is database, before `tools` takes the
 * folder; `database` never takes a path under `.github/`; and `repo-config`
 * takes the `.github/` files no earlier area claimed.
 */
export const DEFAULT_AREAS: readonly DefaultAreaSpec[] = [
  {
    name: "scaffolding",
    description:
      "AI agent scaffolding: agent instructions, skills, rules and agent tool settings",
    paths: [
      ".claude/**",
      ".cursor/**",
      ".codex/**",
      ".windsurf/**",
      ".agents/**",
      ".gemini/**",
      ".roo/**",
      ".continue/**",
      ".aider*",
      ".cursorrules",
      ".windsurfrules",
      ".clinerules*",
      ".mcp.json",
      "**/AGENTS.md",
      "**/CLAUDE.md",
      "**/GEMINI.md",
      ".github/copilot-instructions.md",
      ".github/instructions/**",
      ".github/prompts/**",
      ".github/chatmodes/**",
      ".github/agents/**",
    ],
  },
  {
    name: "ci",
    description: "CI pipelines: workflow and pipeline definitions",
    paths: [
      ".github/workflows/**",
      ".github/actions/**",
      ".gitlab-ci.yml",
      ".gitlab/ci/**",
      ".circleci/**",
      ".buildkite/**",
      "**/Jenkinsfile*",
      "azure-pipelines.yml",
      "bitbucket-pipelines.yml",
      ".travis.yml",
      ".woodpecker*",
      ".woodpecker/**",
    ],
  },
  {
    name: "build",
    description:
      "Build definitions and build tooling: the files of a dedicated build tool (see the build tool table)",
    paths: [],
    tools: { label: "build tool", rows: BUILD_TOOLS },
  },
  {
    name: "database",
    description:
      "Database schema and migrations, by the tool or convention that writes them (see the database table)",
    paths: [],
    tools: { label: "database convention", rows: DATABASE_TOOLS },
    exclude: [".github/**"],
  },
  {
    name: "ops",
    description:
      "Deployment and infrastructure: Terraform, Helm, Kubernetes, Ansible, containers and compose files",
    paths: [
      "deploy*/**",
      "infra/**",
      "infrastructure/**",
      "terraform/**",
      "**/*.tf",
      "**/*.tfvars",
      "charts/**",
      "helm/**",
      "**/Chart.yaml",
      "k8s/**",
      "kubernetes/**",
      "**/kustomization.y*ml",
      "ansible/**",
      "**/Dockerfile*",
      "**/*.dockerfile",
      "**/Containerfile*",
      "**/.dockerignore",
      "**/docker-compose*.y*ml",
      "**/compose.y*ml",
      "**/compose.*.y*ml",
    ],
  },
  {
    name: "tools",
    description:
      "Internal developer tooling that does not ship: tools/, scripts/, bin/, hack/",
    paths: ["tools/**", "scripts/**", "script/**", "bin/**", "hack/**"],
  },
  {
    name: "docs",
    description:
      "Documentation: docs/, doc/, root-level documents and licence files",
    paths: [
      "docs/**",
      "doc/**",
      "*.md",
      "*.rst",
      "*.adoc",
      "LICENSE*",
      "LICENCE*",
      "COPYING*",
    ],
  },
  {
    name: "repo-config",
    description:
      "Repository configuration: root-level files that are not code (manifests, lockfiles, linter and editor settings) and the .github/ files no other area takes (CODEOWNERS, issue templates, dependency-update settings)",
    paths: [".github/**"],
    predicate: {
      test: isRootNonCode,
      rule: "a root-level file that is not code",
    },
  },
];

/** The default areas, compiled. */
export function defaultAreas(): AreaRule[] {
  return DEFAULT_AREAS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    patterns: [
      ...spec.paths.map(compile),
      ...(spec.tools?.rows ?? []).flatMap((t) =>
        t.paths.map((p) => ({
          ...compile(p),
          label: `${spec.tools?.label}: ${t.tool}`,
        })),
      ),
    ],
    content: false,
    ...(spec.exclude ? { exclude: spec.exclude.map(compile) } : {}),
    ...(spec.predicate ? { predicate: spec.predicate } : {}),
  }));
}

/** Parse and check the `code_stats` section; absent, everything defaults. */
export function parseCodeStatsConfig(section: unknown): CodeStatsConfig {
  const value = section ?? {};
  if (!isRecord(value))
    throw new CodeStatsError("code_stats must be a mapping");
  for (const key of Object.keys(value))
    if (!(FIELDS as readonly string[]).includes(key))
      throw new CodeStatsError(
        `code_stats has unknown field ${key} (known: ${FIELDS.join(", ")})`,
      );
  const configuredAreas = value.areas !== undefined;
  const command = value.classify_command ?? null;
  if (
    command !== null &&
    (typeof command !== "string" || command.trim() === "")
  )
    throw new CodeStatsError(
      "code_stats.classify_command must be a shell command (text)",
    );
  const name =
    value.default_area === undefined
      ? DEFAULT_AREA
      : areaName(value.default_area, "code_stats.default_area");
  return {
    configuredAreas,
    areas: configuredAreas ? parseAreas(value.areas) : defaultAreas(),
    defaultArea: name,
    defaultAreaDescription:
      "Files no area rule matched (counted as unclassified)",
    kinds: value.kinds === undefined ? [] : parseKinds(value.kinds),
    modules:
      value.modules === undefined
        ? null
        : patternList(value.modules, "code_stats.modules"),
    classifyCommand: command,
  };
}

/** Every area name a file may carry, in report order. */
export function areaNames(config: CodeStatsConfig): string[] {
  const names = config.areas.map((a) => a.name);
  if (!names.includes(config.defaultArea)) names.push(config.defaultArea);
  return names;
}

/** Each area's description, for the reports. */
export function areaDescriptions(
  config: CodeStatsConfig,
): Record<string, string> {
  // Own entries on a prototype-free object: an area may be named `__proto__`.
  const out: Record<string, string> = Object.create(null);
  out[config.defaultArea] = config.defaultAreaDescription;
  for (const a of config.areas) out[a.name] = a.description;
  return out;
}
