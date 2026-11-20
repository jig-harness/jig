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
 *                                                 or change, or when the
 *                                                 checked-in migrations build
 *                                                 another schema than the
 *                                                 schema file declares
 *
 * The check runs two comparisons, in scratch folders under the
 * repository's ignored `.context/` (drizzle-kit reads the snapshots of an
 * output folder only by a path relative to where it runs), removed after,
 * so it changes nothing tracked. First it generates into a copy of the
 * checked-in folder: drizzle-kit compares the schema with its snapshot of
 * the last migration, so this finds a schema change with no migration.
 * The snapshot says nothing of the SQL files, so it then generates one
 * migration from the schema into an empty folder, applies it and the
 * checked-in migrations each to a fresh in-memory database, and compares
 * the tables and indexes the two build, which finds an SQL file edited by
 * hand. Each migration file also holds only schema statements, never one
 * that inserts or changes rows, and `--check` finds a migration `origin/main`
 * holds that the branch changed. Both modes format the JSON drizzle-kit writes with the
 * repository's pinned formatter, as a commit would.
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
import { Database } from "bun:sqlite";
import type { Config } from "drizzle-kit";
import { cli, strictOptions } from "../../lib/cli.ts";
import {
  drizzle,
  migrate,
} from "../../plugin/shared/vendor/drizzle-bun-sqlite.mjs";

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
/** How long one drizzle-kit run may take before it is stopped. */
const KIT_TIMEOUT_MS = 120_000;
/** How long one formatter run may take before it is stopped. */
const FORMAT_TIMEOUT_MS = 30_000;
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
    { cwd: ROOT, stdout: "pipe", stderr: "pipe", timeout: KIT_TIMEOUT_MS },
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
        timeout: FORMAT_TIMEOUT_MS,
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

/** The tables and indexes `folder`'s migrations build in a fresh database, each as SQLite records it, its SQL's spacing normalized. */
function schemaBuiltBy(folder: string): string[] {
  const client = new Database(":memory:");
  try {
    migrate(drizzle({ client }), { migrationsFolder: folder });
    return client
      .query<
        { type: string; name: string; tbl_name: string; sql: string | null },
        []
      >(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY type, name",
      )
      .all()
      .map(
        (row) =>
          `${row.type} ${row.name} on ${row.tbl_name}: ${(row.sql ?? "").replace(/\s+/g, " ").trim()}`,
      );
  } finally {
    client.close();
  }
}

/** The statements a generated migration holds: schema changes, and the copy into a rebuilt table drizzle-kit writes. */
const SCHEMA_STATEMENT =
  /^(?:CREATE|ALTER|DROP|PRAGMA)\b|^INSERT INTO `__new_/i;

/** Each statement of `folder`'s SQL files that changes data or runs anything but a schema change, named `shown/<file>: <start>`. */
function dataStatements(folder: string, shown: string): string[] {
  return files(folder)
    .filter((path) => path.endsWith(".sql"))
    .flatMap((path) =>
      readFileSync(join(folder, path), "utf8")
        .split("--> statement-breakpoint")
        .map((statement) => statement.replace(/^(?:\s|--[^\n]*\n)+/, ""))
        .filter(
          (statement) => statement !== "" && !SCHEMA_STATEMENT.test(statement),
        )
        .map(
          (statement) =>
            `${shown}/${path} holds a statement that is not a schema change: ${statement.slice(0, 40).replace(/\s+/g, " ")}`,
        ),
    );
}

/**
 * Each migration file `base` (a git revision) already holds that `folder`
 * changes or removes: a migration a hub installed is never replayed, so an
 * edit to one reaches only fresh databases. Empty when `base` cannot be read.
 */
export function editedHistory(
  base: string,
  folder = join(ROOT, MIGRATIONS),
  shown = MIGRATIONS,
): string[] {
  const git = (args: string[]) =>
    Bun.spawnSync(["git", ...args], { cwd: ROOT });
  if (git(["rev-parse", "--verify", `${base}^{commit}`]).exitCode !== 0)
    return [];
  const listed = git(["ls-tree", "-r", "--name-only", base, "--", shown]);
  if (listed.exitCode !== 0) return [];
  return listed.stdout
    .toString()
    .split("\n")
    .filter((path) => path.startsWith(`${shown}/`) && !path.includes("/meta/"))
    .filter((path) => {
      const old = git(["show", `${base}:${path}`]);
      const now = join(folder, path.slice(shown.length + 1));
      return (
        old.exitCode === 0 &&
        (!existsSync(now) ||
          readFileSync(now, "utf8") !== old.stdout.toString())
      );
    })
    .map((path) => `${path} changes a migration ${base} already holds`);
}

/**
 * What is wrong with the migrations in `folder` (the checked-in ones when
 * absent): each file a fresh generation adds or changes, named as
 * `shown/<file>`, and each table or index they build otherwise than the
 * schema declares.
 */
export function migrationProblems(
  folder = join(ROOT, MIGRATIONS),
  shown = MIGRATIONS,
): string[] {
  mkdirSync(join(ROOT, ".context"), { recursive: true });
  const scratch = mkdtempSync(join(ROOT, ".context", "hub-migrations-"));
  try {
    const copy = join(scratch, "migrations");
    if (existsSync(folder)) cpSync(folder, copy, { recursive: true });
    generate(copy, "hub");
    formatJson(copy);
    const stale = files(copy)
      .filter((path) => {
        const current = join(folder, path);
        return (
          !existsSync(current) ||
          readFileSync(current, "utf8") !==
            readFileSync(join(copy, path), "utf8")
        );
      })
      .map(
        (path) =>
          `${shown}/${path} is missing or differs from what the schema generates`,
      );
    const fresh = join(scratch, "fresh");
    generate(fresh, "hub");
    const declared = schemaBuiltBy(fresh);
    let built: string[];
    try {
      built = schemaBuiltBy(folder);
    } catch (error) {
      return [
        ...stale,
        ...dataStatements(folder, shown),
        `${shown} cannot be applied to an empty database: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
    const drift = [
      ...built
        .filter((entry) => !declared.includes(entry))
        .map(
          (entry) =>
            `${shown} builds what the schema does not declare: ${entry}`,
        ),
      ...declared
        .filter((entry) => !built.includes(entry))
        .map(
          (entry) =>
            `${shown} does not build what the schema declares: ${entry}`,
        ),
    ];
    return [...stale, ...dataStatements(folder, shown), ...drift];
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
    const problems = [...migrationProblems(), ...editedHistory("origin/main")];
    for (const problem of problems) console.error(`${problem}; run ${COMMAND}`);
    return problems.length === 0 ? 0 : 1;
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
