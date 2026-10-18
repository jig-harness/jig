// The block structure of a Markdown file as far as a changelog needs it:
// where its headings are, with fenced code blocks left out. Shared by the
// note reader (change-notes.ts) and the writers of each format.

export interface Block {
  title: string;
  text: string;
}

/** A line of a Markdown file, placed against its fenced code blocks. */
export interface FencedLine {
  line: string;
  inFence: boolean;
  delimiter: "open" | "close" | null;
}

/** A comparison or tag link definition: `[label]: https://…`. */
export const LINK_REF = /^\[([^\]]+)\]: (\S+)\s*$/;

/**
 * The lines of `text` with whether each sits inside a fenced code block, so a
 * heading shown as an example in the changelog is not read as structure, and
 * which lines open and close a fence. Both delimiters sit inside the fence. As
 * in CommonMark, a fence closes only on a line holding nothing but a run of
 * its own character at least as long as the one that opened it.
 */
export function fenced(text: string): FencedLine[] {
  let fence: string | null = null;
  const lines: FencedLine[] = [];
  for (const line of text.split("\n")) {
    if (fence === null) {
      // A backtick fence's info string holds no backtick.
      const opener = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1];
      if (opener) fence = opener;
      lines.push(
        opener === undefined
          ? { line, inFence: false, delimiter: null }
          : { line, inFence: true, delimiter: "open" },
      );
      continue;
    }
    const closer = /^ {0,3}(`+|~+)\s*$/.exec(line)?.[1];
    const closes =
      closer !== undefined &&
      closer[0] === fence[0] &&
      closer.length >= fence.length;
    if (closes) fence = null;
    lines.push({ line, inFence: true, delimiter: closes ? "close" : null });
  }
  return lines;
}

/** An ATX heading's level and title, as Markdown renders it; null for any other line. */
export function heading(line: string): { level: number; title: string } | null {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
  return m?.[1] ? { level: m[1].length, title: (m[2] ?? "").trim() } : null;
}

/** Text before the first heading of `level`, then each heading with its text. */
export function blocks(
  text: string,
  level: number,
): { lead: string; parts: Block[] } {
  const lead: string[] = [];
  const parts: { title: string; lines: string[] }[] = [];
  for (const { line, inFence } of fenced(text)) {
    const h = inFence ? null : heading(line);
    if (h?.level === level) parts.push({ title: h.title, lines: [] });
    else (parts.at(-1)?.lines ?? lead).push(line);
  }
  return {
    lead: lead.join("\n").trim(),
    parts: parts.map((p) => ({
      title: p.title,
      text: p.lines.join("\n").trim(),
    })),
  };
}
