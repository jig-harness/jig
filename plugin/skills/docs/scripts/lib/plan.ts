/**
 * The documentation a repository's project type calls for, against what its
 * tree holds. The project type is derived from the tracked files; the
 * expected documents follow M4's three layers (raw sources, a compiled wiki,
 * navigation and meta) and its wiki schema, plus the pages a kind of project
 * needs: runbooks for a service, a reference for a library.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { swallow } from "../../../../shared/errors.ts";
import { isRecord } from "../../../../shared/guards.ts";
import { CANDIDATE_DIRS as DECISION_DIRS } from "../../../adr/scripts/locate.ts";
import { isGeneratedIndex, markdownFiles, readFrontmatter } from "./docs.ts";
import { isDir } from "./settings.ts";

export const PROJECT_TYPES = ["service", "library", "application"] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number] | "unknown";

export interface Detected {
  type: ProjectType;
  /** The tracked file that decided it, or why nothing did. */
  evidence: string;
}

export interface Expected {
  id: string;
  /** What the document is and why the project needs it. */
  what: string;
  /** Where to create it when it is missing. */
  suggested: string;
  /** Where it was found; null when it is missing. */
  found: string | null;
}

/** Folders whose files describe something other than the project itself. */
const NOT_THE_PROJECT =
  /(^|\/)(fixtures?|__tests__|tests?|testdata|examples?|templates?|vendor|node_modules|seeds?)\//;

/** Files that say the project is deployed and run. */
const SERVICE_FILES =
  /(^|\/)(Dockerfile|Containerfile|docker-compose\.ya?ml|compose\.ya?ml|Procfile|fly\.toml|render\.yaml|app\.yaml|serverless\.ya?ml|Chart\.yaml)$|(^|\/)(k8s|kubernetes|helm)\//;

/** A path under the repository, relative to it with `/` separators. */
const repoPath = (repo: string, path: string) =>
  relative(repo, path).split(sep).join("/");

/** A root file's text; "" when there is no such file. */
const text = (repo: string, path: string) =>
  isFile(join(repo, path)) ? readFileSync(join(repo, path), "utf8") : "";

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();

/** The parsed `package.json`; null when it is not valid JSON. */
function packageManifest(repo: string): unknown {
  try {
    return JSON.parse(text(repo, "package.json"));
  } catch (err) {
    swallow(err, "package.json is not valid JSON, so it marks no library");
    return null;
  }
}

/** The root manifest that marks a published library, or null. */
function libraryManifest(repo: string, tracked: Set<string>): string | null {
  const pkg = tracked.has("package.json") ? packageManifest(repo) : null;
  if (
    isRecord(pkg) &&
    pkg.private !== true &&
    (pkg.exports || pkg.main || pkg.module)
  )
    return "package.json (a published package)";
  if (tracked.has("src/lib.rs") && !tracked.has("src/main.rs"))
    return "src/lib.rs (a Rust library crate)";
  const pyproject = text(repo, "pyproject.toml");
  if (
    /^\[project\]/m.test(pyproject) &&
    !/^\[project\.scripts\]/m.test(pyproject)
  )
    return "pyproject.toml (a Python package)";
  const gemspec = [...tracked].find((path) => /^[^/]+\.gemspec$/.test(path));
  if (gemspec) return `${gemspec} (a Ruby gem)`;
  return null;
}

const MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "mix.exs",
];

/** The project type, from the tracked files. */
export function detectProjectType(repo: string, files: string[]): Detected {
  const own = files.filter((path) => !NOT_THE_PROJECT.test(path));
  const service = own.find((path) => SERVICE_FILES.test(path));
  if (service) return { type: "service", evidence: service };
  const tracked = new Set(own);
  const library = libraryManifest(repo, tracked);
  if (library) return { type: "library", evidence: library };
  const manifest = MANIFESTS.find((name) => tracked.has(name));
  if (manifest) return { type: "application", evidence: manifest };
  return { type: "unknown", evidence: "no build manifest or deploy file" };
}

interface Tree {
  root: string | null;
  /** The documents' `type:` values, each with the first document holding it. */
  types: Map<string, string>;
}

/** The `type:` of every readable document under the root, generated ones aside. */
function readTree(repo: string, root: string | null): Tree {
  const types = new Map<string, string>();
  if (root === null) return { root, types };
  for (const path of markdownFiles(join(repo, root)).sort()) {
    const content = readFileSync(path, "utf8");
    if (basename(path) === ".orphans.md" || isGeneratedIndex(content)) continue;
    const type = readFrontmatter(content).fields.get("type");
    const rel = repoPath(repo, path);
    if (typeof type === "string" && !types.has(type)) types.set(type, rel);
  }
  return { root, types };
}

/** The first of `paths` that exists, relative to the repository. */
function firstExisting(repo: string, paths: string[]): string | null {
  return paths.find((path) => existsSync(join(repo, path))) ?? null;
}

/** A folder under the docs root or a document of a `type:`, whichever exists. */
function folderOrType(
  repo: string,
  tree: Tree,
  folders: string[],
  type: string,
): string | null {
  const dirs =
    tree.root === null ? [] : folders.map((f) => `${tree.root}/${f}`);
  return (
    dirs.find((dir) => isDir(join(repo, dir))) ?? tree.types.get(type) ?? null
  );
}

/** Every document the project type expects, with where it was found. */
export function expectedDocuments(
  repo: string,
  root: string | null,
  schema: string | null,
  type: ProjectType,
  decisionDir: string | null,
): Expected[] {
  const tree = readTree(repo, root);
  const docs = root ?? "docs";
  const index = join(repo, docs, "INDEX.md");
  const generatedIndex =
    existsSync(index) && isGeneratedIndex(readFileSync(index, "utf8"));
  const schemaDoc = root === null ? [] : markdownFiles(join(repo, root));
  const wikiSchema = schemaDoc.find((p) =>
    /^wiki-schema\.md$/i.test(basename(p)),
  );
  const expected: Expected[] = [
    {
      id: "docs-tree",
      what: "a docs tree: the compiled wiki's home",
      suggested: `${docs}/`,
      found: root === null ? null : `${root}/`,
    },
    {
      id: "instruction-layer",
      what: "an instruction file agents read first (AGENTS.md or CLAUDE.md), linking the wiki schema",
      suggested: "AGENTS.md",
      found: firstExisting(repo, ["AGENTS.md", "CLAUDE.md"]),
    },
    {
      id: "wiki-schema",
      what: "the written governance model: layers, frontmatter, de-scarring, authority order (from M4's templates/WIKI-SCHEMA.md)",
      suggested: `${docs}/WIKI-SCHEMA.md`,
      found: wikiSchema ? repoPath(repo, wikiSchema) : null,
    },
    {
      id: "frontmatter-schema",
      what: "the machine-read frontmatter vocabulary (from M4's templates/frontmatter-schema.yaml)",
      suggested: `${docs}/.frontmatter-schema.yaml`,
      found: schema,
    },
    {
      id: "index",
      what: "a generated INDEX.md, read first, with its orphan report",
      suggested: `${docs}/INDEX.md`,
      found: generatedIndex ? `${docs}/INDEX.md` : null,
    },
    {
      id: "activity-log",
      what: "log.md, the journal of ingests and wiki-lint runs",
      suggested: `${docs}/log.md`,
      found: firstExisting(repo, [`${docs}/log.md`]),
    },
    {
      id: "decision-records",
      what: "decision records (architecture decision records), second in the authority order",
      suggested: `${docs}/adr/`,
      found: decisionDir,
    },
    {
      id: "raw-layer",
      what: "a raw layer for session notes and post-mortems awaiting promotion",
      suggested: `${docs}/retrospection/`,
      found: folderOrType(
        repo,
        tree,
        ["retrospection", "scratch"],
        "retrospection",
      ),
    },
  ];
  const architecture: Expected = {
    id: "architecture",
    what: "an architecture page: the technical how",
    suggested: `${docs}/architecture/`,
    found: folderOrType(repo, tree, ["architecture"], "architecture"),
  };
  const guide: Expected = {
    id: "guide",
    what: "a guide: getting started and how to use it",
    suggested: `${docs}/guides/`,
    found: folderOrType(repo, tree, ["guides", "guide"], "guide"),
  };
  if (type === "service")
    expected.push(architecture, {
      id: "runbooks",
      what: "runbooks: how to operate, deploy and recover the service",
      suggested: `${docs}/runbooks/`,
      found: folderOrType(repo, tree, ["runbooks", "runbook"], "runbook"),
    });
  if (type === "library")
    expected.push(guide, {
      id: "reference",
      what: "a reference: the public interface, field by field",
      suggested: `${docs}/reference/`,
      found: folderOrType(repo, tree, ["reference", "api"], "reference"),
    });
  if (type === "application") expected.push(architecture, guide);
  return expected;
}

/** The decision-records folder: the configured one, else the first candidate that exists. */
export function decisionDirectory(
  repo: string,
  configured?: string,
): string | null {
  if (configured) return configured;
  return DECISION_DIRS.find((dir) => isDir(join(repo, dir))) ?? null;
}
