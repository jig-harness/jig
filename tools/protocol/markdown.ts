/** The Markdown the generator writes: tables, and the cells in them. */

/** A cell's text with the characters a table row cannot hold escaped. */
export function cell(text: string): string {
  return text.replaceAll("|", "\\|").replaceAll(/\s*\n\s*/g, " ");
}

/** A pipe table: the header row, its rule, then one row per entry. */
export function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const line = (cells: readonly string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(header),
    line(header.map(() => "---")),
    ...rows.map((row) => line(row.map(cell))),
  ].join("\n");
}

/** A number, or an em dash for none. */
export const code = (value: number | null): string =>
  value === null ? "—" : String(value);

/** A yes/no flag, or an em dash for one that asserts nothing. */
export const flag = (value: boolean | null): string =>
  value === null ? "—" : value ? "yes" : "no";
