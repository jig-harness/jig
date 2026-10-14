#!/usr/bin/env bun
// The cumulative instruction chain stays inside the smallest consumer budget.
//
// This models Codex's AGENTS.md chain: Codex walks from the repository root
// down to the working directory, takes at most one instruction file per
// directory and joins them. Codex keeps only the first `project_doc_max_bytes` of the joined
// chain (32,768 bytes by default) and drops the rest without a warning, so
// the budget applies to every root-to-directory chain, not to each file.
//
// Per directory the first file with content wins: AGENTS.override.md, then
// AGENTS.md, then each name in `project_doc_fallback_filenames`. Codex skips
// an instruction file that is empty once trimmed, and trims with Rust's
// `str::trim`, which strips exactly the Unicode White_Space characters; the
// check uses that set, not JavaScript's `trim`, which also strips U+FEFF and
// keeps U+0085, so a file Codex keeps is never taken for blank. Whether an
// empty override still suppresses its directory's AGENTS.md is not something
// its documentation settles, so a blank file is passed over and the next one
// measured, which never counts less than the runtime receives. Files are measured in bytes as encoded on
// disk, and each join between two files counts a blank line ("\n\n"): a
// conservative count of whatever separator the runtime inserts, not a
// statement of it.
//
// Codex layers its project configuration from the repository root down to
// the working directory, so every `.codex/config.toml` among the repository's
// files is a layer, and a chain's `project_doc_max_bytes` and fallback names
// are those of the layers from the root to its directory, the deepest
// setting winning. A directory holding only a layer gets its own chain. The
// budget enforced on a chain is the smaller of that configured value and
// --budget (default 32,768): a consumer that does not read the repository's
// configuration, such as a hosted reviewer, keeps its own default, so raising
// a configured value never raises the gate.
//
// Scope: files git lists for the repository (tracked, plus untracked files
// that are not ignored), so dependencies, other worktrees and scratch state
// never count; outside a git work tree every entry under the root except
// directories, .git and node_modules. A listed file that is gone from the
// work tree is skipped; one that is there but is not a regular file, such as
// a broken link, a FIFO or a link to a device, fails without being read. An
// entry is there when lstat finds it, never when a check that follows links
// does, so a broken link always reaches that failure. Not
// measured: Claude Code's CLAUDE.md files and what their @imports bring in,
// which load by other rules; a person's own
// instruction files, the runtime's system prompt, and configuration outside
// the repository, which no repository file can show.
//
// Usage: bun check-instruction-chain.ts [--budget <bytes>] [--config <file>] [root]
//   --config  Codex configuration to read as the root layer; must exist when
//             named. Without it, <root>/.codex/config.toml is read when an
//             entry is there. Nested layers are read either way.
// Exit: 0 every chain fits; 1 a chain is over budget; 2 usage error, a named
// configuration that does not exist, an unreadable or invalid configuration,
// an unreadable instruction file, or no instruction file at the root.
import { lstatSync } from "node:fs";
import { join, posix } from "node:path";
import { parseArgs } from "node:util";
import { cli } from "../../../../lib/cli.ts";
import { readRegularFile, repoFiles } from "../../../../lib/files.ts";

export const DEFAULT_CHAIN_BUDGET = 32_768;
const PRIMARY_NAMES = ["AGENTS.override.md", "AGENTS.md"];

export type Chain = { directory: string; files: string[]; bytes: number };

/** What one Codex TOML configuration layer sets; unset keys stay undefined. */
export type ConfigLayer = {
  configured: number | undefined;
  fallback: string[] | undefined;
};

export type ChainConfig = { configured: number | undefined; names: string[] };

export function configLayer(raw: string): ConfigLayer {
  const config = Bun.TOML.parse(raw) as Record<string, unknown>;
  const configured = config.project_doc_max_bytes;
  const fallback = config.project_doc_fallback_filenames;
  if (configured !== undefined && !isPositiveInteger(configured))
    throw new Error("project_doc_max_bytes must be a positive integer");
  if (
    fallback !== undefined &&
    !(Array.isArray(fallback) && fallback.every(isPlainFileName))
  )
    throw new Error(
      "project_doc_fallback_filenames must list plain file names",
    );
  return {
    configured: configured as number | undefined,
    fallback: fallback as string[] | undefined,
  };
}

/** The effective settings of layers ordered root first, deepest winning. */
export function effectiveConfig(layers: ConfigLayer[]): ChainConfig {
  let configured: number | undefined;
  let fallback: string[] = [];
  for (const layer of layers) {
    configured = layer.configured ?? configured;
    fallback = layer.fallback ?? fallback;
  }
  return { configured, names: [...new Set([...PRIMARY_NAMES, ...fallback])] };
}

/** The configured budget and file names of a single configuration. */
export function chainConfig(raw: string): ChainConfig {
  return effectiveConfig([configLayer(raw)]);
}

const LAYER = ".codex/config.toml";

/**
 * Configuration layers keyed by the directory they apply from: the root's
 * (`explicit` when named) and every nested one among the repository's files.
 */
export function configLayers(
  root: string,
  files: string[],
  explicit?: string,
): Map<string, ConfigLayer> {
  const layers = new Map<string, ConfigLayer>();
  const rootLayer = explicit ?? join(root, LAYER);
  if (isEntry(rootLayer))
    layers.set(".", readLayer(rootLayer, explicit ?? LAYER));
  for (const listed of files) {
    const path = listed.replaceAll("\\", "/");
    if (path === LAYER || !path.endsWith(`/${LAYER}`)) continue;
    const absolute = join(root, path);
    if (!isEntry(absolute)) continue;
    layers.set(path.slice(0, -LAYER.length - 1), readLayer(absolute, path));
  }
  return layers;
}

/** An entry is at the path, whatever it is or links to. */
function isEntry(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function readLayer(absolute: string, path: string): ConfigLayer {
  try {
    return configLayer(readRegularFile(absolute));
  } catch (cause) {
    throw new Error(
      `unusable configuration ${path}: ${(cause as Error).message}`,
      { cause },
    );
  }
}

/** The effective configuration Codex applies working in `directory`. */
export function configAt(
  layers: Map<string, ConfigLayer>,
  directory: string,
): ChainConfig {
  return effectiveConfig(
    ancestors(directory).flatMap((ancestor) => {
      const layer = layers.get(ancestor);
      return layer ? [layer] : [];
    }),
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPlainFileName(name: unknown): boolean {
  return (
    typeof name === "string" &&
    name.trim() !== "" &&
    !/[/\\]/.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

function ancestors(directory: string): string[] {
  const path: string[] = [];
  for (let cursor = directory; ; cursor = posix.dirname(cursor)) {
    path.unshift(cursor);
    if (cursor === ".") return path;
  }
}

/** Not empty once Rust's `str::trim` has stripped Unicode White_Space. */
export function hasContent(text: string): boolean {
  return !/^\p{White_Space}*$/u.test(text);
}

/**
 * One chain per directory holding an instruction file or a configuration
 * layer, plus the root: any other directory loads the same chain as its
 * nearest such ancestor. `names` is one list for every chain, or the list
 * that applies in a directory.
 */
export function instructionChains(
  documents: Map<string, string>,
  names: string[] | ((directory: string) => string[]),
  layerDirectories: string[] = [],
): Chain[] {
  const namesAt = typeof names === "function" ? names : () => names;
  const directories = new Set([
    ".",
    ...layerDirectories,
    ...[...documents.keys()].map((path) => posix.dirname(path)),
  ]);
  return [...directories].sort().map((directory) => {
    const files = ancestors(directory).flatMap((ancestor) => {
      const chosen = namesAt(directory)
        .map((name) => (ancestor === "." ? name : `${ancestor}/${name}`))
        .find((file) => hasContent(documents.get(file) ?? ""));
      return chosen ? [chosen] : [];
    });
    const joined = files.map((file) => documents.get(file) ?? "").join("\n\n");
    return { directory, files, bytes: Buffer.byteLength(joined, "utf8") };
  });
}

/** The instruction files among the repository's files, keyed by posix path. */
export function readDocuments(
  root: string,
  names: string[],
  files = repoFiles(root, { everyEntry: true }),
): Map<string, string> {
  const documents = new Map<string, string>();
  for (const listed of files) {
    // Git reports forward slashes; the non-git walk uses the platform's.
    const path = listed.replaceAll("\\", "/");
    if (!names.includes(posix.basename(path))) continue;
    const absolute = join(root, path);
    if (!isEntry(absolute)) continue;
    documents.set(path, readInstructionFile(absolute, path));
  }
  return documents;
}

function readInstructionFile(absolute: string, path: string): string {
  try {
    return readRegularFile(absolute);
  } catch (cause) {
    throw new Error(
      `unreadable instruction file ${path}: ${(cause as Error).message}`,
      {
        cause,
      },
    );
  }
}

export function checkInstructionChain(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { budget: { type: "string" }, config: { type: "string" } },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length > 1)
    throw new Error(
      "usage: check-instruction-chain.ts [--budget <bytes>] [--config <file>] [root]",
    );
  const root = positionals[0] ?? ".";
  const consumer = Number(values.budget ?? DEFAULT_CHAIN_BUDGET);
  if (!isPositiveInteger(consumer))
    throw new Error("--budget must be a positive integer");
  if (values.config !== undefined && !isEntry(values.config))
    throw new Error(`config not found: ${values.config}`);
  const files = repoFiles(root, { everyEntry: true });
  const layers = configLayers(root, files, values.config);
  const at = (directory: string) => configAt(layers, directory);
  const budgetAt = (directory: string) =>
    Math.min(at(directory).configured ?? consumer, consumer);
  const everyName = [
    ...new Set(
      [".", ...layers.keys()].flatMap((directory) => at(directory).names),
    ),
  ];
  const documents = readDocuments(root, everyName, files);
  const { names, configured } = at(".");
  if (!names.some((name) => documents.has(name)))
    throw new Error(
      `no instruction file at the root of ${root} (looked for ${names.join(", ")})`,
    );
  const chains = instructionChains(
    documents,
    (directory) => at(directory).names,
    [...layers.keys()],
  );
  for (const directory of [...layers.keys()].filter((d) => d !== "."))
    console.log(
      `  layer ${directory}/${LAYER}: budget ${budgetAt(directory)} bytes from ${directory} down`,
    );
  return report(chains, budgetAt, configured);
}

function report(
  chains: Chain[],
  budgetAt: (directory: string) => number,
  configured?: number,
): number {
  const largest = chains.reduce((a, b) => (b.bytes > a.bytes ? b : a));
  const source =
    configured === undefined
      ? "no configured value"
      : `configured ${configured}`;
  console.log(
    `Instruction chain budget: ${budgetAt(".")} bytes (${source}); largest chain ${largest.bytes} bytes at ${largest.directory}: ${largest.files.join(" + ")}`,
  );
  const over = chains.filter(
    (chain) => chain.bytes > budgetAt(chain.directory),
  );
  for (const chain of over) {
    const budget = budgetAt(chain.directory);
    console.error(
      `FAIL ${chain.directory}: ${chain.bytes} > ${budget} bytes; the last ${chain.bytes - budget} bytes of ${chain.files.join(" + ")} never reach the runtime`,
    );
  }
  return over.length ? 1 : 0;
}

if (import.meta.main) cli(() => checkInstructionChain(process.argv.slice(2)));
