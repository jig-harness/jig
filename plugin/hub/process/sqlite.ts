/**
 * The process adapter's database: one SQLite file through `bun:sqlite`, in
 * write-ahead-log mode, with the hub's checked-in migrations applied
 * ([design/control-plane.md § Storage](../../../design/control-plane.md#storage)).
 *
 * This is the adapter's side, never the portable core's: it opens a file
 * and reads the migrations from disk with Drizzle's `bun:sqlite` migrator.
 * What it returns is the Drizzle database the storage implementation
 * (`plugin/hub/storage/storage.ts`) runs every operation over. Each
 * connection the adapter opens (its listener's, a worker's) comes from here,
 * and they share the file: write-ahead-log mode lets them read while one
 * writes, and the busy timeout makes a writer wait its turn instead of
 * failing at once.
 */
import { Database, SQLiteError } from "bun:sqlite";
import { join } from "node:path";
import { attempt, type Outcome } from "../../shared/outcome.ts";
import type { ThrownClass } from "../storage/storage.ts";
import {
  type BunSQLiteDatabase,
  drizzle,
  migrate,
} from "../../shared/vendor/drizzle-bun-sqlite.mjs";

/** The hub's migrations, as `bun tools/hub/migrations.ts` writes them. */
export const MIGRATIONS_FOLDER = join(import.meta.dir, "../storage/migrations");

/** How long a connection waits for another's write before it fails as busy. */
export const BUSY_TIMEOUT_MS = 5_000;

/** An open hub database: Drizzle's, over the connection it closes. */
export interface HubSqlite {
  readonly db: BunSQLiteDatabase;
  /** The connection itself, for what Drizzle does not cover (a pragma, a checkpoint). */
  readonly client: Database;
  /**
   * What a throw from this connection is, for the storage implementation
   * (`createStorage(db, { classify })`).
   */
  classify(thrown: unknown): ThrownClass;
  /** Closes the connection, once; the database is unusable after. */
  close(): void;
}

/** How many causes deep a classifier looks: Drizzle wraps a driver's error once. */
const CAUSE_DEPTH = 4;

/** The codes of a store that cannot answer now; any other code is a statement the code got wrong. */
const UNAVAILABLE_CODES = [
  "SQLITE_BUSY",
  "SQLITE_LOCKED",
  "SQLITE_IOERR",
  "SQLITE_CANTOPEN",
  "SQLITE_FULL",
  "SQLITE_READONLY",
  "SQLITE_CORRUPT",
  "SQLITE_NOTADB",
  "SQLITE_NOMEM",
  "SQLITE_PROTOCOL",
  "SQLITE_INTERRUPT",
  "SQLITE_NOLFS",
  "SQLITE_AUTH",
] as const;

/**
 * Classifies what `bun:sqlite`, or Drizzle wrapping it, threw, walking the
 * chain of causes by type and code, never by message: a `SQLiteError`
 * whose code is a constraint's (`SQLITE_CONSTRAINT…`) is `refused`, and one of the operational
 * codes (busy, locked, unreadable, full) `unavailable`, and any other
 * (invalid SQL, a missing table) a `defect`; the
 * `RangeError` `bun:sqlite` throws for a closed connection is
 * `unavailable` when `closed()` says this connection was closed. Anything
 * else is a `defect`.
 */
export function classifyBunSqlite(
  closed: () => boolean,
): (thrown: unknown) => ThrownClass {
  return (thrown) => {
    let link: unknown = thrown;
    for (
      let depth = 0;
      depth <= CAUSE_DEPTH && link instanceof Error;
      depth++
    ) {
      const found = classifyLink(link, closed);
      if (found !== null) return found;
      link = link.cause;
    }
    return "defect";
  };
}

/** The class one error in a cause chain settles, or `null` to look at its cause. */
function classifyLink(link: Error, closed: () => boolean): ThrownClass | null {
  if (link instanceof SQLiteError) {
    const code = typeof link.code === "string" ? link.code : "";
    if (code.startsWith("SQLITE_CONSTRAINT")) return "refused";
    return UNAVAILABLE_CODES.some((prefix) => code.startsWith(prefix))
      ? "unavailable"
      : "defect";
  }
  return link instanceof RangeError && closed() ? "unavailable" : null;
}

/**
 * Opens (creating it if absent) the hub's database at `path`, sets
 * write-ahead-log mode, the busy timeout and foreign keys, and applies
 * every migration not yet applied. Fails `unavailable` when the file
 * cannot be opened or a migration cannot be applied.
 */
export function openHubSqlite(path: string): Outcome<HubSqlite, "unavailable"> {
  const opened = attempt(
    "unavailable",
    `opening the hub's database ${path}`,
    () => new Database(path, { create: true, strict: true }),
  );
  if (!opened.ok) return opened;
  const client = opened.value;
  const ready = attempt(
    "unavailable",
    `preparing the hub's database ${path}`,
    () => {
      client.run(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      client.run("PRAGMA journal_mode = WAL");
      client.run("PRAGMA foreign_keys = ON");
      const db = drizzle({ client });
      migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
      return db;
    },
  );
  if (!ready.ok) {
    client.close();
    return ready;
  }
  let closed = false;
  return {
    ok: true,
    value: {
      db: ready.value,
      client,
      classify: classifyBunSqlite(() => closed),
      close: () => {
        if (closed) return;
        closed = true;
        client.close();
      },
    },
  };
}
