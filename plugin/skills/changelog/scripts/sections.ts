// What the format writers share: merging notes' entries into a release's
// sections in the format's order, and rendering a release.
import type { ChangeNote } from "./change-notes.ts";
import type { Format } from "./formats.ts";
import type { Block } from "./markdown-blocks.ts";
import type { HostLinks } from "./remote.ts";

export interface ApplyOptions {
  /** The version the notes release; null when none asks for one. */
  version: string | null;
  /** The release date, year-month-day. */
  date: string;
  /** What a version's tag puts before it, such as `v`. */
  tagPrefix: string;
  /**
   * Keep a Changelog: whether a note without a release is written under
   * Unreleased at once (`write`) or goes into the next release (`wait`).
   */
  unreleased: "write" | "wait";
  /**
   * The links the hosting service gives the repository, which a Common
   * Changelog release is linked with; null when it has none Jig knows.
   */
  links: HostLinks | null;
}

/** Each note's entries merged into `into` by change type, keeping types in the format's order. */
export function mergeSections(
  into: Block[],
  notes: ChangeNote[],
  format: Format,
): Block[] {
  const out = into.map((b) => ({ ...b }));
  const rank = (title: string) => format.sections.indexOf(title);
  for (const note of notes)
    for (const [title, items] of note.sections) {
      const existing = out.find((b) => b.title === title);
      if (existing) {
        existing.text = [existing.text, ...items].filter(Boolean).join("\n");
        continue;
      }
      const after = out.findIndex(
        (b) => rank(b.title) > rank(title) && rank(b.title) >= 0,
      );
      const block = { title, text: items.join("\n") };
      if (after === -1) out.push(block);
      else out.splice(after, 0, block);
    }
  return out;
}

/** A heading, an optional lead and the sections, as a changelog holds them. */
export function render(heading: string, lead: string, parts: Block[]): string {
  return [
    heading,
    ...(lead ? [lead] : []),
    ...parts.map((p) => `### ${p.title}\n\n${p.text}`),
  ].join("\n\n");
}
