// @bun
// Drizzle (drizzle-orm) 0.45.4, Apache License 2.0 (drizzle.LICENSE), bundled by `bun tools/plugin/vendor-drizzle.ts`; do not edit.
import {
  entityKind,
  sql2,
  eq2,
  and2,
  or2,
  gt2,
  gte2,
  lt2,
  lte2,
  inArray2,
  isNull2,
  isNotNull2,
  integer2,
  text2,
  SQLiteTable,
  sqliteTable2
} from "./drizzle-shared.mjs";
// node_modules/drizzle-orm/sqlite-core/indexes.js
class IndexBuilderOn {
  constructor(name, unique) {
    this.name = name;
    this.unique = unique;
  }
  static [entityKind] = "SQLiteIndexBuilderOn";
  on(...columns) {
    return new IndexBuilder(this.name, columns, this.unique);
  }
}

class IndexBuilder {
  static [entityKind] = "SQLiteIndexBuilder";
  config;
  constructor(name, columns, unique) {
    this.config = {
      name,
      columns,
      unique,
      where: undefined
    };
  }
  where(condition) {
    this.config.where = condition;
    return this;
  }
  build(table) {
    return new Index(this.config, table);
  }
}

class Index {
  static [entityKind] = "SQLiteIndex";
  config;
  constructor(config, table) {
    this.config = { ...config, table };
  }
}
function index(name) {
  return new IndexBuilderOn(name, false);
}
function uniqueIndex(name) {
  return new IndexBuilderOn(name, true);
}

// node_modules/drizzle-orm/sqlite-core/primary-keys.js
function primaryKey(...config) {
  if (config[0].columns) {
    return new PrimaryKeyBuilder(config[0].columns, config[0].name);
  }
  return new PrimaryKeyBuilder(config);
}

class PrimaryKeyBuilder {
  static [entityKind] = "SQLitePrimaryKeyBuilder";
  columns;
  name;
  constructor(columns, name) {
    this.columns = columns;
    this.name = name;
  }
  build(table) {
    return new PrimaryKey(table, this.columns, this.name);
  }
}

class PrimaryKey {
  constructor(table, columns, name) {
    this.table = table;
    this.columns = columns;
    this.name = name;
  }
  static [entityKind] = "SQLitePrimaryKey";
  columns;
  name;
  getName() {
    return this.name ?? `${this.table[SQLiteTable.Symbol.Name]}_${this.columns.map((column) => column.name).join("_")}_pk`;
  }
}
export {
  and2 as and,
  eq2 as eq,
  gt2 as gt,
  gte2 as gte,
  inArray2 as inArray,
  index,
  integer2 as integer,
  isNotNull2 as isNotNull,
  isNull2 as isNull,
  lt2 as lt,
  lte2 as lte,
  or2 as or,
  primaryKey,
  sql2 as sql,
  sqliteTable2 as sqliteTable,
  text2 as text,
  uniqueIndex
};
