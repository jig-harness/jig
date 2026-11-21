// The parts of Drizzle that open a `bun:sqlite` database and apply the
// migrations checked in beside the hub's schema: the process adapter's
// alone, never the portable core's. vendor-drizzle.ts bundles this file
// with drizzle-entry.ts, so the code both use sits once in a shared chunk;
// add a name here, then run `bun tools/plugin/vendor-drizzle.ts`.
export { drizzle } from "drizzle-orm/bun-sqlite";
export type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
export { migrate } from "drizzle-orm/bun-sqlite/migrator";
