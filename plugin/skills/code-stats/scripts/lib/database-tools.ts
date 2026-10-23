/**
 * The database conventions the default `database` area recognises: schema
 * definitions (DDL, data definition language) and migrations, by the tool
 * or framework that writes them, as data. Specific tools come before the
 * generic rules, so `--explain` names the most specific one. A plain `.sql`
 * file is not schema by itself (it may be a query), so no rule takes every
 * `.sql` file; and a migration's kind is still what the kind rules say.
 */
import type { ToolRule } from "./tool-rules.ts";

export const DATABASE_TOOLS: readonly ToolRule[] = [
  {
    tool: "Rails",
    ecosystem: "Ruby",
    paths: ["db/migrate/**", "db/schema.rb", "db/structure.sql", "db/seeds.rb"],
    example: "db/migrate/20260101000000_create_users.rb",
  },
  {
    tool: "Laravel",
    ecosystem: "PHP",
    paths: [
      "database/migrations/**",
      "database/seeders/**",
      "database/factories/**",
    ],
    example: "database/migrations/2026_01_01_create_users_table.php",
  },
  {
    tool: "Ecto",
    ecosystem: "Elixir",
    paths: ["priv/repo/migrations/**"],
    example: "priv/repo/migrations/20260101_create_users.exs",
  },
  {
    tool: "Entity Framework Core",
    ecosystem: ".NET",
    paths: ["**/Migrations/*.cs"],
    example: "src/Api/Migrations/20260101_Initial.cs",
  },
  {
    tool: "Django",
    ecosystem: "Python",
    paths: ["**/migrations/*.py"],
    example: "shop/migrations/0001_initial.py",
  },
  {
    tool: "Alembic",
    ecosystem: "Python",
    paths: ["**/alembic.ini", "**/alembic/**"],
    example: "services/api/alembic/versions/0001_users.py",
  },
  {
    tool: "Prisma",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/schema.prisma", "**/prisma/migrations/**"],
    example: "packages/db/prisma/schema.prisma",
  },
  {
    tool: "Drizzle",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/drizzle.config.*", "**/drizzle/**"],
    example: "packages/db/drizzle.config.ts",
  },
  {
    tool: "Knex",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/knexfile.*"],
    example: "knexfile.js",
  },
  {
    tool: "Sequelize",
    ecosystem: "JavaScript/TypeScript",
    paths: ["**/.sequelizerc"],
    example: ".sequelizerc",
  },
  {
    tool: "Supabase",
    ecosystem: "Postgres",
    paths: ["supabase/migrations/**"],
    example: "supabase/migrations/20260101000000_init.sql",
  },
  {
    tool: "Hasura",
    ecosystem: "GraphQL",
    paths: ["hasura/migrations/**", "hasura/metadata/**"],
    example: "hasura/metadata/databases/databases.yaml",
  },
  {
    tool: "Flyway",
    ecosystem: "JVM and others",
    paths: ["**/db/migration/**", "**/flyway.conf", "**/flyway.toml"],
    example: "src/main/resources/db/migration/V1__init.sql",
  },
  {
    tool: "Liquibase",
    ecosystem: "JVM and others",
    paths: ["**/db/changelog/**", "**/liquibase.properties"],
    example: "src/main/resources/db/changelog/db.changelog-master.yaml",
  },
  {
    tool: "Atlas",
    ecosystem: "Any",
    paths: ["**/atlas.hcl"],
    example: "atlas.hcl",
  },
  {
    tool: "Sqitch",
    ecosystem: "Any",
    paths: ["**/sqitch.plan", "**/sqitch.conf"],
    example: "sqitch.plan",
  },
  {
    tool: "golang-migrate or dbmate",
    ecosystem: "Any",
    paths: ["**/*.up.sql", "**/*.down.sql"],
    example: "internal/store/sql/0001_users.up.sql",
  },
  {
    tool: "generic migrations folder",
    ecosystem: "Any",
    paths: ["**/migrations/**", "**/migration/**", "**/db/migrate/**"],
    example: "tools/db/migrations/0001_init.sql",
  },
  {
    tool: "generic schema file",
    ecosystem: "Any",
    paths: ["**/*.ddl", "**/schema.sql", "**/structure.sql"],
    example: "apps/api/schema.sql",
  },
  {
    tool: "generic seed folder",
    ecosystem: "Any",
    paths: [
      "**/db/seeds/**",
      "**/db/seeders/**",
      "**/database/seeds/**",
      "**/database/seeders/**",
    ],
    example: "services/api/db/seeds/users.sql",
  },
];
