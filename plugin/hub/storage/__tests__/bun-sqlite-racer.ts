/**
 * The storage contract's racer on `bun:sqlite`: a worker thread that opens
 * its own connection to the database file the contract names and races
 * (`racer.ts`).
 */
import { workerData } from "node:worker_threads";
import { openHubSqlite } from "../../process/sqlite.ts";
import { createStorage } from "../storage.ts";
import { race } from "./racer.ts";

const { path } = workerData as { path: string };
const sqlite = openHubSqlite(path);
if (!sqlite.ok) throw new Error(sqlite.failure.reason);
try {
  await race(createStorage(sqlite.value.db));
} finally {
  sqlite.value.close();
}
