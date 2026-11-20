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
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { attempt, type Outcome } from "../../shared/outcome.ts";
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
  /** Closes the connection; the database is unusable after. */
  close(): void;
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
  return {
    ok: true,
    value: { db: ready.value, client, close: () => client.close() },
  };
}
