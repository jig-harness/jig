/**
 * Read one tracked file, classify it and count its lines. A symbolic link
 * and a submodule are entries of their own, never followed; a media file is
 * sized only; a text file too large to count is classified from its first
 * 8 KB but not line-counted; a file with a NUL byte in its first 8 KB is
 * binary whatever its extension says.
 */
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { errnoCode } from "../../../../shared/errors.ts";
import { HEAD_CHARS } from "./banner.ts";
import {
  classify,
  type FileFacts,
  lineStyle,
  type Override,
} from "./classify.ts";
import type { CodeStatsConfig } from "./config.ts";
import { countLines } from "./count.ts";
import type { Attributes } from "./git.ts";
import {
  ASSET_EXTENSIONS,
  getExtension,
  shebangLanguage,
} from "./languages.ts";
import type { Classification, FileStats } from "./model.ts";
import type { ModuleMap } from "./modules.ts";

/** Text files above this are sized but not line-counted. */
export const MAX_LINE_COUNT_BYTES = 20 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8192;
const CONCURRENCY = 32;
/**
 * Files above this size are read a few at a time, so the workers never hold
 * more than `LARGE_AT_ONCE` large files (each up to `MAX_LINE_COUNT_BYTES`,
 * read whole and decoded) in memory at once.
 */
const LARGE_FILE_BYTES = 1024 * 1024;
const LARGE_AT_ONCE = 2;
const decoder = new TextDecoder();

/**
 * A gate that runs at most `limit` jobs at once, the rest in arrival order.
 * A finishing job hands its slot straight to the next waiting one, so a job
 * arriving while the waiter wakes cannot take the slot too.
 */
export function createLimiter(limit: number) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (running >= limit)
      await new Promise<void>((resolve) => waiting.push(resolve));
    else running++;
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running--;
    }
  };
}

const largeReads = createLimiter(LARGE_AT_ONCE);

/** What every file's analysis reads. */
export interface Context {
  root: string;
  config: CodeStatsConfig;
  modules: ModuleMap;
  attributes: Attributes;
  submodules: ReadonlySet<string>;
  overrides: ReadonlyMap<string, Override>;
}

export interface AnalyzedFile {
  stats: FileStats;
  classification: Classification;
}

const ZERO = { raw: 0, blank: 0, comment: 0, code: 0 };

function result(
  facts: FileFacts,
  ctx: Context,
  bytes: number,
  counts: typeof ZERO,
  classification = classify(
    facts,
    ctx.config,
    ctx.modules,
    ctx.overrides.get(facts.path),
  ),
): AnalyzedFile {
  const { area, kind, language, module } = classification;
  return {
    classification,
    stats: {
      path: facts.path,
      area: area.value,
      kind: kind.value,
      language: language.value,
      module: module.value,
      areaMatched: classification.areaMatched,
      bytes,
      rawLines: counts.raw,
      blankLines: counts.blank,
      commentLines: counts.comment,
      codeLines: counts.code,
    },
  };
}

/**
 * Analyze `relPath`. Null when the path is missing from the working tree
 * (deleted but still tracked); any other failure to look it up is thrown, so
 * a file never drops out of the totals unseen.
 */
export async function analyzeFile(
  relPath: string,
  ctx: Context,
): Promise<AnalyzedFile | null> {
  const filename = relPath.split("/").pop() ?? "";
  const ext = getExtension(filename);
  const facts: FileFacts = {
    path: relPath,
    filename,
    ext,
    attributes: ctx.attributes.get(relPath),
    shape: "unread",
    head: "",
    shebang: null,
  };
  const abs = resolve(ctx.root, relPath);
  const st = await lstat(abs).catch((err: unknown) => {
    if (errnoCode(err) === "ENOENT") return null;
    throw err;
  });
  if (!st) return null;
  if (ctx.submodules.has(relPath) || st.isDirectory())
    return result({ ...facts, shape: "submodule" }, ctx, 0, ZERO);
  if (st.isSymbolicLink())
    return result({ ...facts, shape: "symlink" }, ctx, st.size, ZERO);
  if (ASSET_EXTENSIONS.has(ext)) return result(facts, ctx, st.size, ZERO);

  const whole = st.size <= MAX_LINE_COUNT_BYTES;
  const read = () => readText(facts, ctx, abs, st.size, whole);
  return whole && st.size > LARGE_FILE_BYTES ? largeReads(read) : read();
}

/**
 * Read a text-or-binary file, classify it and, when `whole`, count its
 * lines; otherwise only its first `BINARY_PROBE_BYTES` are read.
 */
async function readText(
  facts: FileFacts,
  ctx: Context,
  abs: string,
  size: number,
  whole: boolean,
): Promise<AnalyzedFile> {
  const relPath = facts.path;
  const file = Bun.file(abs);
  const buf = new Uint8Array(
    await (whole ? file : file.slice(0, BINARY_PROBE_BYTES)).arrayBuffer(),
  );
  if (buf.subarray(0, BINARY_PROBE_BYTES).includes(0))
    return result({ ...facts, shape: "binary" }, ctx, size, ZERO);

  const content = decoder.decode(buf);
  const head = content.slice(0, HEAD_CHARS);
  const text: FileFacts = {
    ...facts,
    shape: "text",
    head,
    shebang: shebangLanguage(head),
  };
  const classification = classify(
    text,
    ctx.config,
    ctx.modules,
    ctx.overrides.get(relPath),
  );
  const counts = whole
    ? countLines(content, lineStyle(text, classification.language.value))
    : ZERO;
  return result(text, ctx, size, counts, classification);
}

/** Analyze every path, `CONCURRENCY` at a time, sorted by path. */
export async function analyzeAll(
  paths: readonly string[],
  ctx: Context,
): Promise<{ files: AnalyzedFile[]; missing: number }> {
  const files: AnalyzedFile[] = [];
  let missing = 0;
  let next = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (next < paths.length) {
      const path = paths[next++] as string;
      const analyzed = await analyzeFile(path, ctx);
      if (analyzed) files.push(analyzed);
      else missing++;
    }
  });
  await Promise.all(workers);
  files.sort((a, b) => (a.stats.path < b.stats.path ? -1 : 1));
  return { files, missing };
}
