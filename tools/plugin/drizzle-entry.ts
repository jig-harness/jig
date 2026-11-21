// The parts of Drizzle, the object-relational mapper the hub's storage is
// written with, that the hub's schema and its storage operations import:
// SQLite's dialect and the query builder, nothing bound to one runtime.
// vendor-drizzle.ts bundles this file and drizzle-bun-sqlite-entry.ts from
// the pinned package into plugin/shared/vendor/ and writes each file's export
// statements as that bundle's declarations; add a name here, then run
// `bun tools/plugin/vendor-drizzle.ts`.
export {
  and,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
export type { InferSelectModel, SQL, SQLWrapper } from "drizzle-orm";
export {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
export type {
  BaseSQLiteDatabase,
  SQLiteColumn,
  SQLiteTable,
} from "drizzle-orm/sqlite-core";
