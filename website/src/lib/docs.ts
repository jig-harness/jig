/**
 * Lookups into the `docs` collection (see content.config.ts).
 */
import { type CollectionEntry, getCollection } from "astro:content";

export type Doc = CollectionEntry<"docs">;

/** Every document whose id matches, sorted by id. */
export async function docsMatching(pattern: RegExp): Promise<Doc[]> {
  const all = await getCollection("docs", (e) => pattern.test(e.id));
  return all.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
}

/** A document's title: its first level-one heading, without Markdown marks. */
export function titleOf(entry: Doc): string {
  const line = /^# (.+)$/m.exec(entry.body ?? "")?.[1] ?? entry.id;
  return line.replace(/[`*_]/g, "").trim();
}
