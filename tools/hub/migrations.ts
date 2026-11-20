#!/usr/bin/env bun
/**
 * Generates the hub's storage migrations from its schema with `drizzle-kit`
 * (a development dependency only; it never ships):
 *
 *   plugin/hub/storage/schema.ts      the source: the hub's tables
 *   plugin/hub/storage/migrations/    the derived files: one SQL file per
 *                                     schema change, and drizzle-kit's
 *                                     journal and snapshots in meta/
 *
 * Each adapter applies the checked-in migrations when the hub starts, so
 * they are derived files: never edited, and never merged by hand. A branch
 * that changes the schema while another branch's migration lands first
 * takes the other branch's migrations as they are, drops its own, and
 * regenerates.
 *
 * Usage:
 *   bun tools/hub/migrations.ts [--name <name>]   write a migration for what
 *                                                 the schema changed, named
 *                                                 <name> (default "hub");
 *                                                 nothing when it changed
 *                                                 nothing
 *   bun tools/hub/migrations.ts --check           exit 1 naming each file a
 *                                                 fresh generation would add
 *                                                 or change
 *
 * The check generates into a copy of the checked-in folder under the
 * repository's ignored `.context/` (drizzle-kit reads the snapshots of an
 * output folder only by a path relative to where it runs), so it changes
 * nothing tracked; drizzle-kit's snapshot of the last migration is
 * what it compares the schema with. Both modes format the JSON drizzle-kit
 * writes with the repository's pinned formatter, as a commit would.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Config } from "drizzle-kit";
import { cli, strictOptions } from "../../lib/cli.ts";

const ROOT = resolve(import.meta.dir, "../..");
/** What drizzle-kit generates from: the hub's schema, in SQLite's dialect. */
const CONFIG = {
  dialect: "sqlite",
  schema: "plugin/hub/storage/schema.ts",
} as const satisfies Config;
export const MIGRATIONS = "plugin/hub/storage/migrations";
const KIT = "node_modules/drizzle-kit/bin.cjs";
const COMMAND = "bun tools/hub/migrations.ts";
const USAGE = `Usage: ${COMMAND} [--name <name>] | --check`;
/** A migration's name: what drizzle-kit puts after its number in the file name. */
const NAME = /^[a-z][a-z0-9_]*$/;

/** A generation that could not run; the message says why. */
class MigrationsError extends Error {
  override name = "MigrationsError";
}

/** What drizzle-kit prints when it generated, or found nothing to generate. */
const GENERATED =
  /Your SQL migration file|No schema changes, nothing to migrate/;

/**
 * Runs `drizzle-kit generate` from the repository root into `out`, a
 * folder under the root. drizzle-kit reports some failures (a snapshot it
 * cannot read) and still exits 0, so its answer is read from what it prints.
 */
function generate(out: string, name: string): void {
  const run = Bun.spawnSync(
    [
      process.execPath,
      KIT,
      "generate",
      "--dialect",
      CONFIG.dialect,
      "--schema",
      CONFIG.schema,
      "--out",
      relative(ROOT, out).replaceAll("\\", "/"),
      "--name",
      name,
    ],
    { cwd: ROOT, stdout: "pipe", stderr: "pipe" },
  );
  const printed = `${run.stdout.toString()}${run.stderr.toString()}`;
  if (run.exitCode !== 0 || !GENERATED.test(printed))
    throw new MigrationsError(
      `drizzle-kit generate failed (exit ${run.exitCode}):\n${printed}`,
    );
}

/** Formats each JSON file under `dir` in place, as the repository's formatter writes it. */
function formatJson(dir: string): void {
  for (const path of files(dir).filter((p) => p.endsWith(".json"))) {
    const run = Bun.spawnSync(
      [
        process.execPath,
        join(ROOT, "node_modules/@biomejs/biome/bin/biome"),
        "format",
        `--stdin-file-path=${MIGRATIONS}/${path}`,
      ],
      {
        cwd: ROOT,
        stdin: readFileSync(join(dir, path)),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    if (run.exitCode !== 0)
      throw new MigrationsError(
        `formatting ${path} failed (exit ${run.exitCode}):\n${run.stderr.toString()}`,
      );
    writeFileSync(join(dir, path), run.stdout.toString());
  }
}

/** Every file under `dir`, as paths relative to it, sorted. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((path) => statSync(join(dir, path)).isFile())
    .map((path) => path.replaceAll("\\", "/"))
    .sort();
}

/**
 * The files of the checked-in migrations a fresh generation adds or
 * changes, as repository paths.
 */
export function staleMigrations(): string[] {
  mkdirSync(join(ROOT, ".context"), { recursive: true });
  const scratch = mkdtempSync(join(ROOT, ".context", "hub-migrations-"));
  try {
    const checkedIn = join(ROOT, MIGRATIONS);
    const copy = join(scratch, "migrations");
    if (existsSync(checkedIn)) cpSync(checkedIn, copy, { recursive: true });
    generate(copy, "hub");
    formatJson(copy);
    return files(copy)
      .filter((path) => {
        const current = join(checkedIn, path);
        return (
          !existsSync(current) ||
          readFileSync(current, "utf8") !==
            readFileSync(join(copy, path), "utf8")
        );
      })
      .map((path) => `${MIGRATIONS}/${path}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(args: string[]): number {
  const { values } = strictOptions(
    {
      args,
      options: { name: { type: "string" }, check: { type: "boolean" } },
    },
    USAGE,
  );
  if (values.check) {
    if (values.name !== undefined) {
      console.error(USAGE);
      return 2;
    }
    const stale = staleMigrations();
    for (const path of stale)
      console.error(
        `${path} is missing or differs from what the schema generates; run ${COMMAND}`,
      );
    return stale.length === 0 ? 0 : 1;
  }
  const name = values.name ?? "hub";
  if (!NAME.test(name)) {
    console.error(`--name takes lower-case letters, digits and _\n${USAGE}`);
    return 2;
  }
  const before = new Set(files(join(ROOT, MIGRATIONS)));
  generate(join(ROOT, MIGRATIONS), name);
  formatJson(join(ROOT, MIGRATIONS));
  const added = files(join(ROOT, MIGRATIONS)).filter((p) => !before.has(p));
  console.log(
    added.length === 0
      ? "the schema changed nothing; no migration written"
      : `wrote ${added.map((p) => `${MIGRATIONS}/${p}`).join(", ")}`,
  );
  return 0;
}

if (import.meta.main) cli(() => main(process.argv.slice(2)));
