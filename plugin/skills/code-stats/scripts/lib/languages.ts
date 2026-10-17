/**
 * What a file's name says about it: its extension, the extension groups the
 * kind rules read, the language each extension names, and the comment style
 * the line counter strips. A file without an extension can name its language
 * in a shebang line (`#!/usr/bin/env bash`), and a repository can name it
 * with the `linguist-language` attribute.
 */

/**
 * A comment syntax: `c` (line and block comments as in C), `js` (C with
 * regular-expression literals), `nested` (C with block comments that nest),
 * `hash` (`#`), `python` (`#` with `"""` and `'''` strings), `sql`,
 * `html`, or `none`.
 */
export type CommentStyle =
  | "c"
  | "js"
  | "nested"
  | "hash"
  | "python"
  | "sql"
  | "html"
  | "none";

/** Hand-written source in a programming, markup or style language. */
export const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "sql",
  "sh",
  "bash",
  "zsh",
  "bats",
  "css",
  "scss",
  "html",
  "astro",
  "proto",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "rb",
  "php",
  "vue",
  "svelte",
  "rego",
  "hcl",
  "tf",
  "grit",
  "ps1",
  "ftl",
  "tmpl",
  "kts",
  "scala",
  "groovy",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "cs",
  "fs",
  "ex",
  "exs",
  "r",
  "pl",
  "pm",
  "psm1",
  "lua",
  "dart",
  "less",
  "sass",
]);

export const DOC_EXTENSIONS = new Set([
  "md",
  "mdx",
  "rst",
  "txt",
  "adoc",
  "mmd",
]);

export const CONFIG_EXTENSIONS = new Set([
  "json",
  "json5",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "xml",
  "ini",
  "env",
  "example",
  "editorconfig",
  "gitignore",
  "gitkeep",
  "gitattributes",
  "dockerignore",
  "npmrc",
  "nvmrc",
  "lock",
  "properties",
  "bru",
  "conf",
  "cfg",
]);

export const DATA_EXTENSIONS = new Set([
  "ttl",
  "csv",
  "tsv",
  "rdf",
  "owl",
  "ndjson",
  "jsonl",
  "parquet",
  "eml",
]);

/** Binary and media files: sized, never line-counted. */
export const ASSET_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "ico",
  "webp",
  "pdf",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "zip",
  "gz",
  "tar",
  "xlsx",
  "xls",
  "docx",
  "pptx",
  "odt",
  "mp4",
  "mov",
  "webm",
  "mp3",
  "wav",
  "fig",
  "tiff",
  "tif",
  "heic",
  "msg",
]);

/** Extensionless file names that hold build or tool configuration. */
export const CONFIG_FILE_NAMES =
  /^(dockerfile|makefile|justfile|procfile|brewfile)$/i;

/** Extensionless file names that hold documentation. */
export const DOC_FILE_NAMES = new Set(["LICENSE"]);

const LANGUAGE_NAMES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TSX",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  py: "Python",
  sql: "SQL",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  bats: "Shell",
  css: "CSS",
  scss: "CSS",
  less: "CSS",
  sass: "CSS",
  html: "HTML",
  astro: "Astro",
  proto: "Protobuf",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  groovy: "Groovy",
  swift: "Swift",
  rb: "Ruby",
  php: "PHP",
  vue: "Vue",
  svelte: "Svelte",
  c: "C",
  h: "C",
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  hpp: "C++",
  hh: "C++",
  cs: "C#",
  fs: "F#",
  ex: "Elixir",
  exs: "Elixir",
  r: "R",
  pl: "Perl",
  pm: "Perl",
  lua: "Lua",
  dart: "Dart",
  rego: "Rego",
  hcl: "HCL",
  tf: "HCL",
  grit: "Grit",
  ps1: "PowerShell",
  psm1: "PowerShell",
  ftl: "FreeMarker",
  tmpl: "Go template",
  mmd: "Mermaid",
  bru: "Bruno",
  xsd: "XML",
  snap: "Snapshot",
  peggy: "Peggy grammar",
  license: "License text",
  gitignore: "Dotfile",
  gitattributes: "Dotfile",
  dockerignore: "Dotfile",
  editorconfig: "Dotfile",
  npmrc: "Dotfile",
  nvmrc: "Dotfile",
  env: "Dotfile",
  example: "Example config",
  md: "Markdown",
  mdx: "MDX",
  txt: "Text",
  json: "JSON",
  json5: "JSON",
  jsonc: "JSON",
  ndjson: "JSON",
  jsonl: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  xml: "XML",
  ttl: "Turtle (RDF)",
  rdf: "Turtle (RDF)",
  owl: "Turtle (RDF)",
  csv: "CSV",
  tsv: "CSV",
  dockerfile: "Dockerfile",
};

const JS_STYLE = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);

/** C-family languages whose block comments nest. */
const NESTED_STYLE = new Set(["rs", "kt", "kts", "swift", "scala", "dart"]);

const C_STYLE = new Set([
  "css",
  "scss",
  "go",
  "java",
  "proto",
  "json5",
  "jsonc",
  "groovy",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "cs",
  "fs",
  "php",
  "less",
  "sass",
]);

const HASH_STYLE = new Set([
  "sh",
  "bash",
  "zsh",
  "bats",
  "yaml",
  "yml",
  "toml",
  "rb",
  "ttl",
  "rego",
  "hcl",
  "tf",
  "dockerfile",
  "ex",
  "exs",
  "r",
  "pl",
  "pm",
  "ps1",
  "psm1",
]);

const HTML_STYLE = new Set([
  "html",
  "xml",
  "md",
  "mdx",
  "vue",
  "svelte",
  "astro",
]);

/** The comment syntax the line counter recognises for an extension. */
export function commentStyle(ext: string): CommentStyle {
  if (JS_STYLE.has(ext)) return "js";
  if (NESTED_STYLE.has(ext)) return "nested";
  if (C_STYLE.has(ext)) return "c";
  if (ext === "py" || ext === "pyi") return "python";
  if (HASH_STYLE.has(ext)) return "hash";
  if (ext === "sql") return "sql";
  if (HTML_STYLE.has(ext)) return "html";
  return "none";
}

/**
 * The extension the rules read: the last dot-separated part, lower-cased.
 * An extensionless file stands for itself (`Makefile` reads `makefile`), and
 * `Dockerfile.<anything>` reads `dockerfile`.
 */
export function getExtension(filename: string): string {
  if (!filename.includes(".")) return filename.toLowerCase();
  if (/^Dockerfile\./i.test(filename)) return "dockerfile";
  const parts = filename.split(".");
  return (parts[parts.length - 1] as string).toLowerCase();
}

/** The language an extension names, or null when it names none. */
export function languageOfExtension(ext: string): string | null {
  return Object.hasOwn(LANGUAGE_NAMES, ext)
    ? (LANGUAGE_NAMES[ext] as string)
    : null;
}

/** Interpreters a shebang line may name, by the language they run. */
const SHEBANG_LANGUAGES: Record<string, string> = {
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  dash: "Shell",
  ksh: "Shell",
  python: "Python",
  python2: "Python",
  python3: "Python",
  node: "JavaScript",
  bun: "TypeScript",
  deno: "TypeScript",
  "ts-node": "TypeScript",
  tsx: "TypeScript",
  ruby: "Ruby",
  perl: "Perl",
  php: "PHP",
  pwsh: "PowerShell",
  Rscript: "R",
  elixir: "Elixir",
  lua: "Lua",
};

/**
 * The language a shebang line names, with the line itself, or null. Reads
 * `#!/bin/bash`, `#!/usr/bin/env python3` and `#!/usr/bin/env -S bun run`;
 * a trailing version (`python3.12`) is dropped.
 */
export function shebangLanguage(
  head: string,
): { language: string; line: string } | null {
  if (!head.startsWith("#!")) return null;
  const line = (head.split("\n", 1)[0] as string).replace(/\r$/, "");
  const words = line.slice(2).trim().split(/\s+/);
  let program = (words[0] ?? "").split("/").pop() ?? "";
  if (program === "env") {
    const next = words.slice(1).find((w) => !w.startsWith("-"));
    program = next ?? "";
  }
  const base = program.replace(/\d+(\.\d+)*$/, "");
  const own = (key: string) =>
    Object.hasOwn(SHEBANG_LANGUAGES, key) ? SHEBANG_LANGUAGES[key] : undefined;
  const language = own(program) ?? own(base);
  return language === undefined ? null : { language, line };
}

/** The comment style of each language some extension names, where it has one. */
const LANGUAGE_STYLES = new Map<string, CommentStyle>();
/** The languages whose files are code. */
const CODE_LANGUAGES = new Set<string>();
for (const [ext, name] of Object.entries(LANGUAGE_NAMES)) {
  const style = commentStyle(ext);
  const key = name.toLowerCase();
  if (style !== "none" && !LANGUAGE_STYLES.has(key))
    LANGUAGE_STYLES.set(key, style);
  if (CODE_EXTENSIONS.has(ext)) CODE_LANGUAGES.add(key);
}

/** The comment style of a language named by a shebang or an attribute. */
export function languageCommentStyle(language: string): CommentStyle {
  return LANGUAGE_STYLES.get(language.toLowerCase()) ?? "none";
}

/** Whether files in `language` are code (as opposed to data or prose). */
export function isCodeLanguage(language: string): boolean {
  return CODE_LANGUAGES.has(language.toLowerCase());
}
