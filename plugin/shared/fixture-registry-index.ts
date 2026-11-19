/**
 * A rebuildable name index for the flat fixture store. Registry folders stay
 * authoritative. SQLite serializes admissions across test processes and gives
 * collection a bounded ordered range without sorting the directory each run.
 */
import { Database } from "bun:sqlite";
import {
  closeSync,
  type Dir,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errnoCode, swallow } from "./errors.ts";
import { attempt, failed, JigError, ok, type Outcome } from "./outcome.ts";

export const FIXTURE_REGISTRY_LIMIT = 100_000;

export function fixtureRegistryLimit(): number {
  const configured = process.env.JIG_TEST_FIXTURE_REGISTRY_LIMIT;
  if (configured === undefined || !/^[1-9][0-9]*$/.test(configured))
    return FIXTURE_REGISTRY_LIMIT;
  const limit = Number(configured);
  return Number.isSafeInteger(limit) ? limit : FIXTURE_REGISTRY_LIMIT;
}

export function testFixtureRegistryRoot(home = homedir()): string {
  return join(home, ".local", "state", "jig", "test-fixtures-v1");
}

const SCHEMA = `
    CREATE TABLE fixture_registry_names (name TEXT PRIMARY KEY COLLATE BINARY) WITHOUT ROWID;
    CREATE TABLE fixture_registry_index (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      witness TEXT,
      count INTEGER NOT NULL DEFAULT 0,
      collection_cursor TEXT,
      admission_cursor TEXT
    );
    INSERT INTO fixture_registry_index (id) VALUES (1);
    CREATE TRIGGER fixture_registry_added AFTER INSERT ON fixture_registry_names BEGIN
      UPDATE fixture_registry_index SET count = count + 1 WHERE id = 1;
    END;
    CREATE TRIGGER fixture_registry_removed AFTER DELETE ON fixture_registry_names BEGIN
      UPDATE fixture_registry_index SET count = count - 1 WHERE id = 1;
    END;
    PRAGMA user_version = 1;
`;

function openIndex(store: string): Database {
  const file = indexPath(store);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  closeSync(openSync(file, "a", 0o600));
  const db = new Database(file, { create: false });
  try {
    db.exec("PRAGMA busy_timeout = 10000;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function versionOf(db: Database): number | undefined {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()
    ?.user_version;
}

/** A prior collector wrote the last folder as a JSON string. */
function legacyCursor(store: string): string | null {
  const file = `${store}.cursor`;
  try {
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size > 4096) return null;
    const name: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof name === "string" &&
      name !== "" &&
      name !== "." &&
      name !== ".." &&
      !name.includes("/") &&
      !name.includes("\0") &&
      (process.platform !== "win32" || !name.includes("\\"))
      ? name
      : null;
  } catch (error) {
    swallow(
      error,
      "an unreadable legacy fixture cursor starts from the beginning",
    );
    return null;
  }
}

function ensureSchema(db: Database, store: string): void {
  const version = versionOf(db);
  if (version === 0) {
    db.exec(SCHEMA);
    new FixtureNameIndex(db).advance("collection_cursor", legacyCursor(store));
  } else if (version !== 1)
    throw new JigError(
      "fixture-index",
      `Unsupported fixture name index version ${version}`,
    );
}

function indexPath(store: string): string {
  return `${store}.index.sqlite`;
}

/** A top-level creation or removal changes the directory's witness. */
function witness(store: string): string {
  const stat = lstatSync(store, { bigint: true, throwIfNoEntry: false });
  return stat
    ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}:${stat.mtimeNs}`
    : "absent";
}

/** Walk entries with kernel-backed directory buffering; return false when a visitor stopped early. */
export function visitFixtureRegistryNames(
  store: string,
  visit: (name: string) => boolean,
): boolean {
  let dir: Dir;
  try {
    dir = opendirSync(store);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return true;
    throw error;
  }
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync())
      if (visit(entry.name) === false) return false;
    return true;
  } finally {
    dir.closeSync();
  }
}

type Cursor = "collection_cursor" | "admission_cursor";
interface FixtureNamePage {
  names: string[];
  complete: boolean;
  after: string | null;
}

export class FixtureNameIndex {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  count(): number {
    const count = this.db
      .query<{ count: number }, []>(
        "SELECT count FROM fixture_registry_index WHERE id = 1",
      )
      .get()?.count;
    if (count === undefined || !Number.isSafeInteger(count) || count < 0)
      throw new JigError(
        "fixture-index",
        "The index has a missing or invalid registry count",
      );
    return count;
  }

  add(name: string): void {
    this.db
      .query("INSERT OR IGNORE INTO fixture_registry_names (name) VALUES (?)")
      .run(name);
  }

  remove(name: string): void {
    this.db
      .query("DELETE FROM fixture_registry_names WHERE name = ?")
      .run(name);
  }

  page(cursor: Cursor, limit: number): FixtureNamePage {
    // The cursor is a key, so a vanished cursor entry need not be retained.
    const after =
      this.db
        .query<{ value: string | null }, []>(
          `SELECT ${cursor} AS value FROM fixture_registry_index WHERE id = 1`,
        )
        .get()?.value ?? null;
    const size = Math.max(0, Math.ceil(limit));
    const forward = this.db
      .query<{ name: string }, [string, number]>(
        "SELECT name FROM fixture_registry_names WHERE name > ? ORDER BY name LIMIT ?",
      )
      .all(after ?? "", size);
    const wrapped =
      forward.length < size
        ? this.db
            .query<{ name: string }, [string, number]>(
              "SELECT name FROM fixture_registry_names WHERE name <= ? ORDER BY name LIMIT ?",
            )
            .all(after ?? "", size - forward.length)
        : [];
    const names = [...forward, ...wrapped].map(({ name }) => name);
    return { names, complete: names.length === this.count(), after };
  }

  advance(cursor: Cursor, after: string | null): void {
    this.db
      .query(`UPDATE fixture_registry_index SET ${cursor} = ? WHERE id = 1`)
      .run(after);
  }

  advanceCollection(after: string | null, next: string | null): void {
    this.db
      .query(
        "UPDATE fixture_registry_index SET collection_cursor = ? WHERE id = 1 AND collection_cursor IS ?",
      )
      .run(next, after);
  }

  matches(seen: string): boolean {
    return (
      this.db
        .query<{ witness: string | null }, []>(
          "SELECT witness FROM fixture_registry_index WHERE id = 1",
        )
        .get()?.witness === seen
    );
  }

  rebuild(store: string): void {
    this.db.exec("DELETE FROM fixture_registry_names");
    visitFixtureRegistryNames(store, (name) => {
      this.add(name);
      return true;
    });
  }

  record(seen: string): void {
    this.db
      .query("UPDATE fixture_registry_index SET witness = ? WHERE id = 1")
      .run(seen);
  }
}

/**
 * An interrupted update leaves the old witness in SQLite, so the next
 * transaction streams the actual directory once and repairs its index before
 * admitting work. The witness also detects earlier Jig copies or a manual
 * drain changing the flat directory outside this transaction.
 */
export function withFixtureNameIndex<T>(
  store: string,
  use: (index: FixtureNameIndex) => T,
  guard: (body: () => T) => T = (body) => body(),
): Outcome<T> {
  return attempt(
    "fixture-index",
    "Cannot update the fixture registry index",
    () => {
      // This is coordination and derived data for test scratch, not an
      // operational Jig records database. A source checkout also owns fixtures.
      const db = openIndex(store);
      try {
        return db
          .transaction(() =>
            guard(() => {
              ensureSchema(db, store);
              const index = new FixtureNameIndex(db);
              index.count();
              const before = witness(store);
              if (!index.matches(before)) {
                index.rebuild(store);
                if (witness(store) !== before)
                  throw new JigError(
                    "fixture-index",
                    "The fixture directory changed during inventory",
                  );
                index.record(before);
              }
              return use(index);
            }),
          )
          .immediate();
      } finally {
        db.close();
      }
    },
  );
}

export function recordFixtureNameChange(
  index: FixtureNameIndex,
  store: string,
): void {
  index.record(witness(store));
}

function indexedCount(store: string): number | null {
  const file = indexPath(store);
  if (!lstatSync(file, { throwIfNoEntry: false })) return null;
  const db = new Database(file, { readonly: true });
  try {
    return db.transaction(() => {
      if (versionOf(db) !== 1) return null;
      const index = new FixtureNameIndex(db);
      const before = witness(store);
      if (!index.matches(before)) return null;
      const count = index.count();
      return witness(store) === before ? count : null;
    })();
  } finally {
    db.close();
  }
}

export function fixtureRegistryUsage(
  store = testFixtureRegistryRoot(),
): Outcome<{ count: number; limit: number }> {
  const counted = attempt(
    "fixture-index",
    "Cannot read the fixture registry size",
    () => {
      const indexed = indexedCount(store);
      if (indexed !== null) return indexed;
      const before = witness(store);
      let count = 0;
      visitFixtureRegistryNames(store, () => {
        count++;
        return true;
      });
      return witness(store) === before ? count : null;
    },
  );
  if (!counted.ok) return counted;
  return counted.value === null
    ? failed(
        "fixture-index",
        "Cannot count the fixture registry while its directory is changing",
      )
    : ok({ count: counted.value, limit: fixtureRegistryLimit() });
}
