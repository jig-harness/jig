/** Notion ids, as people paste them and as the API returns them. */

/**
 * The id in a Notion id or link (the last 32 hexadecimal digits, with or
 * without dashes), in the dashed form the API returns; null when there is
 * none.
 */
export function notionId(raw: string): string | null {
  const path = raw.trim().split(/[?#]/)[0] ?? "";
  const matches = path.replaceAll("-", "").match(/[0-9a-fA-F]{32}/g);
  const hex = matches?.at(-1)?.toLowerCase();
  if (hex === undefined) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** An id without dashes, the form Notion's links use. */
export function compactId(id: string): string {
  return id.replaceAll("-", "");
}
