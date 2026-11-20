/**
 * The hub's migrations check: the checked-in migrations pass, and a copy
 * whose SQL was edited by hand fails, though drizzle-kit's snapshot of it
 * is unchanged. Each run of drizzle-kit takes a second or so.
 */
import { afterAll, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { editedHistory, MIGRATIONS, migrationProblems } from "./migrations.ts";

const root = resolve(import.meta.dir, "../..");
const scratch = mkdtempSync(join(tmpdir(), "hub-migrations-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

test("the checked-in migrations are what the schema generates", () => {
  expect(migrationProblems()).toEqual([]);
}, 60_000);

test("an SQL file edited by hand is found, its snapshot unchanged", () => {
  const copy = join(scratch, "edited");
  cpSync(join(root, MIGRATIONS), copy, { recursive: true });
  const sql = readdirSync(copy).find((name) => name.endsWith(".sql"));
  if (sql === undefined) throw new Error(`no SQL file in ${MIGRATIONS}`);
  appendFileSync(
    join(copy, sql),
    "--> statement-breakpoint\nCREATE INDEX `job_leases_updated` ON `job_leases` (`partition`,`updated_at`);",
  );
  expect(migrationProblems(copy, "edited")).toEqual([
    "edited builds what the schema does not declare: index job_leases_updated on job_leases: CREATE INDEX `job_leases_updated` ON `job_leases` (`partition`,`updated_at`)",
  ]);
}, 60_000);

test("a statement that changes rows is found, though the schema it builds is unchanged", () => {
  const copy = join(scratch, "data");
  cpSync(join(root, MIGRATIONS), copy, { recursive: true });
  const sql = readdirSync(copy).find((name) => name.endsWith(".sql"));
  if (sql === undefined) throw new Error(`no SQL file in ${MIGRATIONS}`);
  appendFileSync(
    join(copy, sql),
    "\n--> statement-breakpoint\nINSERT INTO `job_leases` (`partition`,`job`,`started_at`,`updated_at`) VALUES ('p','j',0,0);",
  );
  expect(migrationProblems(copy, "data")).toEqual([
    "data/0000_hub.sql holds a statement that is not a schema change: INSERT INTO `job_leases` (`partition`,`j",
  ]);
}, 60_000);

test("a migration the base already holds, edited, is found", () => {
  const copy = join(scratch, "history");
  cpSync(join(root, MIGRATIONS), copy, { recursive: true });
  const sql = readdirSync(copy).find((name) => name.endsWith(".sql"));
  if (sql === undefined) throw new Error(`no SQL file in ${MIGRATIONS}`);
  appendFileSync(join(copy, sql), "\n");
  expect(editedHistory("HEAD", copy)).toEqual([
    `${MIGRATIONS}/${sql} changes a migration HEAD already holds`,
  ]);
  expect(editedHistory("HEAD", join(root, MIGRATIONS))).toEqual([]);
  expect(editedHistory("no-such-revision", copy)).toEqual([]);
});
