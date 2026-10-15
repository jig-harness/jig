#!/usr/bin/env bun
/**
 * The filesystem store: a folder of JSONL files, behind the store contract.
 *
 * Usage: bun filesystem-store.ts --path <folder> <check|append|list|diagnose>
 *
 *   check     {"ok":true}, or {"ok":false,"reason":…,"fix":…}
 *   append    JSONL events on stdin → {"stored":[{"id":…,"ref":…}]}
 *   list      optional {"since":…} on stdin → JSONL events, each id once
 *   diagnose  JSONL notices: each id stored with different events
 *
 * Each `append` writes one new file, `<folder>/<year>-<month>/<time>-<16
 * random hexadecimal digits>.jsonl`: written under a temporary name in the
 * same folder, then linked into place without replacing a file already there,
 * so a reader never sees half a file and no write removes another's. Nothing
 * is appended to an existing file, edited or deleted, so writers in different
 * repositories and worktrees never touch the same file, and a folder synced
 * between machines merges without conflicts.
 *
 * Exit codes: 0 done; 1 failed (the reason on stderr); 2 usage; 3 the folder
 * is unavailable.
 */
import { randomBytes } from "node:crypto";
import {
  accessSync,
  existsSync,
  constants,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { runMain } from "../../resolve-review-comments/scripts/lib/cli.ts";
import {
  distinctById,
  idConflicts,
  parseEvent,
  type StoredEvent,
} from "./lib/events.ts";
import { appendInput, sinceInput } from "./lib/store-io.ts";

const TEMP_PREFIX = ".tmp-";

interface Copy extends StoredEvent {
  id: string;
  ref: string;
}

function usage(message: string): number {
  console.error(
    `${message}\nusage: filesystem-store.ts <check|append|list|diagnose> --path <folder>`,
  );
  return 2;
}

function check(folder: string): number {
  try {
    mkdirSync(folder, { recursive: true });
    accessSync(folder, constants.W_OK);
    const probe = join(
      folder,
      `${TEMP_PREFIX}check-${randomBytes(8).toString("hex")}`,
    );
    writeFileSync(probe, "");
    rmSync(probe);
    console.log(JSON.stringify({ ok: true }));
  } catch (error) {
    console.log(
      JSON.stringify({
        ok: false,
        reason: `the store folder ${folder} is not writable: ${error instanceof Error ? error.message : String(error)}`,
        fix: "create the folder and make it writable, or point reflection.path at one that is",
      }),
    );
  }
  return 0;
}

/** Errors of a filesystem that has no hard links (FAT, many network shares). */
const NO_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

/**
 * Move a complete temporary file to its final name without replacing a file
 * already there. A link does both at once. On a filesystem without links the
 * temporary file is renamed, which shows a reader only the complete file; a
 * rename could replace a file of the same name, so it is refused when one
 * exists, and the 16 random digits in every name leave only a writer racing
 * on that very name in between.
 */
function placeWithoutReplacing(temp: string, final: string): void {
  try {
    linkSync(temp, final);
  } catch (error) {
    if (!NO_LINKS.has(String((error as NodeJS.ErrnoException).code)))
      throw error;
    if (existsSync(final)) throw new Error(`${final} already exists`);
    renameSync(temp, final);
  }
}

function fileName(now: Date): { month: string; name: string } {
  const iso = now.toISOString();
  const month = iso.slice(0, 7);
  const time = iso.slice(0, 19).replaceAll("-", "").replaceAll(":", "");
  return { month, name: `${time}Z-${randomBytes(8).toString("hex")}.jsonl` };
}

async function append(folder: string): Promise<number> {
  const input = await appendInput();
  if ("problem" in input) {
    console.error(input.problem);
    return 1;
  }
  const lines = input.events.map((line) => line.text);
  const ids = input.events.map((line) => line.event.id);
  if (lines.length === 0) {
    console.log(JSON.stringify({ stored: [] }));
    return 0;
  }
  const { month, name } = fileName(new Date());
  const dir = join(folder, month);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (error) {
    console.error(
      `cannot create ${dir}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 3;
  }
  const temp = join(dir, `${TEMP_PREFIX}${name}`);
  const final = join(dir, name);
  writeFileSync(temp, `${lines.join("\n")}\n`, { flag: "wx" });
  try {
    placeWithoutReplacing(temp, final);
  } finally {
    rmSync(temp, { force: true });
  }
  const stored = ids.map((id, index) => ({
    id,
    ref: `${final}:${index + 1}`,
  }));
  console.log(JSON.stringify({ stored }));
  return 0;
}

function storeFiles(folder: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(TEMP_PREFIX)) continue;
      const path = join(dir, entry.name);
      // A link is neither walked nor skipped: listing past it would return
      // an incomplete store as if it were whole.
      if (entry.isSymbolicLink())
        throw new Error(
          `${relative(folder, path)} is a symbolic link; the store holds only files and folders`,
        );
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        files.push(path);
    }
  };
  walk(folder);
  return files.sort();
}

/** Every copy of every event in one store file; throws on a line that is not one. */
function fileCopies(folder: string, file: string): Copy[] {
  const copies: Copy[] = [];
  for (const [index, raw] of readFileSync(file, "utf8").split("\n").entries()) {
    const text = raw.replace(/\r$/, "");
    if (text.trim() === "") continue;
    const where = `${relative(folder, file)}:${index + 1}`;
    let event: ReturnType<typeof parseEvent>;
    try {
      event = parseEvent(text);
    } catch (error) {
      throw new Error(
        `${where} is not a reflection event: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    copies.push({ event, text, id: event.id, ref: `${file}:${index + 1}` });
  }
  return copies;
}

/** Every copy of every event in the folder; an absent folder holds none. */
function readCopies(folder: string): Copy[] {
  if (!existsSync(folder)) return [];
  if (!statSync(folder).isDirectory())
    throw new Error(`${folder} is not a folder`);
  return storeFiles(folder).flatMap((file) => fileCopies(folder, file));
}

async function list(folder: string): Promise<number> {
  const since = await sinceInput();
  const events = distinctById(readCopies(folder)).filter(
    (stored) => since === null || stored.event.at >= since,
  );
  for (const stored of events) process.stdout.write(`${stored.text}\n`);
  return 0;
}

function diagnose(folder: string): number {
  for (const [id, copies] of idConflicts(readCopies(folder)))
    process.stdout.write(
      `${JSON.stringify({
        kind: "id-conflict",
        id,
        copies: copies.map((copy) => ({ ref: copy.ref, text: copy.text })),
      })}\n`,
    );
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  // The caller appends the operation to the configured command, so it may
  // come after the options.
  let op: string | undefined;
  let folder: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--path" && argv[i + 1] !== undefined) folder = argv[++i];
    else if (op === undefined && !argv[i]?.startsWith("--")) op = argv[i];
    else return usage(`unknown argument: ${argv[i]}`);
  }
  if (folder === undefined) return usage("--path is required");
  try {
    switch (op) {
      case "check":
        return check(folder);
      case "append":
        return await append(folder);
      case "list":
        return await list(folder);
      case "diagnose":
        return diagnose(folder);
      default:
        return usage(
          op === undefined ? "missing operation" : `unknown operation: ${op}`,
        );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main)
  runMain("filesystem-store.ts", () => main(process.argv.slice(2)));
