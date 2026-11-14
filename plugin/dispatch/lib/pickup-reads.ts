/**
 * What a tick's reads keep for the next tick: assignment metadata, which a
 * changed tracker timestamp invalidates, and the page size a forge query
 * read at (`tick-reads.ts`).
 */
import { swallow } from "../../shared/errors.ts";
import { stateDb } from "./state.ts";

export interface PickupReads {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
}

/** Cache failures cost a fresh tracker read; they never authorize a launch. */
export const pickupReads: PickupReads = {
  get<T>(key: string): T | null {
    try {
      const row = stateDb()
        .query("SELECT value FROM pickup_reads WHERE key = ?")
        .get(key) as { value: string } | null;
      const parsed: unknown = row === null ? null : JSON.parse(row.value);
      return parsed as T | null;
    } catch (error) {
      swallow(error, "read pickup cache");
      return null;
    }
  },
  set(key, value) {
    try {
      stateDb()
        .query("INSERT OR REPLACE INTO pickup_reads (key,value) VALUES (?,?)")
        .run(key, JSON.stringify(value));
    } catch (error) {
      swallow(error, "write pickup cache");
    }
  },
};
