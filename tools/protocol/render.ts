/**
 * What the generator writes into a chapter or the index page: the title and
 * status line at the top of a chapter, and each generated section between
 * its markers. The prose around them is left as it is.
 */
import {
  type Chapter,
  chapterFile,
  dataFile,
  INDEX_SOURCE,
  ISSUE_URL,
  PROTOCOL_DIR,
} from "./chapter.ts";
import { table } from "./markdown.ts";

const START = /^<!-- protocol:generated source=(\S+) -->$/;
const END = "<!-- /protocol:generated -->";

export const startMarker = (source: string): string =>
  `<!-- protocol:generated source=${source} -->`;
export const END_MARKER = END;

/** A plan item, linked to its epic issue. */
const planLink = (p: { item: number; epic: number }) =>
  `[plan item ${p.item}](${ISSUE_URL}${p.epic})`;

/** The chapter's status line: its version, and `stable` or `provisional` with the plan items that move it. */
export function statusLine(chapter: Chapter): string {
  const head = `Version ${chapter.version} · ${chapter.status}`;
  if (chapter.status === "stable") return head;
  return `${head}, moved by ${chapter.planItems.map(planLink).join(", ")}`;
}

/** What a splice found: the new text, or what keeps the file from being spliced. */
export type Splice =
  | { ok: true; text: string; sections: string[]; current: string[] }
  | { ok: false; problems: string[] };

/**
 * `text` with each generated section's body replaced by `bodies`, matched to
 * the markers in order. `sources` is what each marker must name. Returns the
 * new text with each section's new and current body, or why it cannot: a
 * marker that names another source, an unclosed or a stray end marker, or a
 * count of markers that differs from the sections the list names.
 */
export function spliceSections(
  text: string,
  sources: readonly string[],
  bodies: readonly string[],
): Splice {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  const problems: string[] = [];
  const current: string[] = [];
  let open: { source: string; line: number; body: string[] } | null = null;
  let index = 0;
  lines.forEach((line, i) => {
    const start = START.exec(line);
    if (start) {
      if (open)
        problems.push(
          `line ${i + 1}: a start marker inside the section opened at line ${open.line}`,
        );
      const source = start[1] as string;
      const expected = sources[index];
      if (expected === undefined)
        problems.push(
          `line ${i + 1}: a marker for source ${source}, but the chapter list names ${sources.length} generated section(s)`,
        );
      else if (source !== expected)
        problems.push(
          `line ${i + 1}: the marker names source ${source}, but the chapter list names ${expected} for section ${index + 1}`,
        );
      out.push(startMarker(expected ?? source));
      open = { source, line: i + 1, body: [] };
      return;
    }
    if (line === END) {
      if (!open) {
        problems.push(`line ${i + 1}: an end marker with no section open`);
        out.push(line);
        return;
      }
      current.push(open.body.join("\n"));
      out.push("", (bodies[index] ?? "").trimEnd(), "", END);
      open = null;
      index += 1;
      return;
    }
    if (open) open.body.push(line);
    else out.push(line);
  });
  // An unclosed section still answers for the source its marker names.
  const seen = open === null ? index : index + 1;
  if (open !== null)
    problems.push(
      `line ${(open as { line: number }).line}: a section with no end marker`,
    );
  if (seen < sources.length)
    problems.push(
      `${sources.length - seen} generated section(s) the chapter list names have no markers: ${sources.slice(seen).join(", ")}`,
    );
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    text: out.join("\n"),
    sections: bodies.map((b) => `\n${b.trimEnd()}\n`),
    current,
  };
}

/**
 * The chapter's file with its title, status line and generated sections as
 * the list and the code give them. The file opens with its title, a blank
 * line and its status line, which the generator rewrites.
 */
export function renderChapter(chapter: Chapter, text: string): Splice {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (
    !lines[0]?.startsWith("# ") ||
    lines[1] !== "" ||
    !lines[2]?.startsWith("Version ")
  )
    return {
      ok: false,
      problems: [
        "the chapter must open with its `# ` title, a blank line and its status line (`Version …`)",
      ],
    };
  const head = [`# ${chapter.title}`, "", statusLine(chapter)];
  const spliced = spliceSections(
    [...head, ...lines.slice(3)].join("\n"),
    chapter.sections.map((s) => s.source),
    chapter.sections.map((s) => s.render()),
  );
  return spliced;
}

/** The index page's generated list: each chapter with its version, status and data file. */
export function indexList(chapters: readonly Chapter[]): string {
  const prefix = `${PROTOCOL_DIR}/`;
  const local = (path: string) => path.slice(prefix.length);
  return table(
    ["Chapter", "What it covers", "Version", "Status", "Data file"],
    chapters.map((c) => [
      `[${c.title}](${local(chapterFile(c.id))})`,
      c.summary,
      String(c.version),
      c.status === "stable"
        ? "stable"
        : `provisional, moved by ${c.planItems.map(planLink).join(", ")}`,
      `[${local(dataFile(c.id))}](${local(dataFile(c.id))})`,
    ]),
  );
}

/** The index page with its generated list as the chapter list gives it. */
export function renderIndex(
  chapters: readonly Chapter[],
  text: string,
): Splice {
  return spliceSections(text, [INDEX_SOURCE], [indexList(chapters)]);
}
