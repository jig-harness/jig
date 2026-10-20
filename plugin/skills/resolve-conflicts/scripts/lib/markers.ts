/**
 * Conflict markers: the lines git writes into a file around each region it
 * could not merge.
 *
 *   <<<<<<< ours-label
 *   ours text
 *   ||||||| base-label     (only with merge.conflictStyle diff3 or zdiff3)
 *   base text
 *   =======
 *   theirs text
 *   >>>>>>> theirs-label
 *
 * Each marker is the marker character repeated `size` times (7 by default,
 * or the path's `conflict-marker-size` attribute), followed by a space and a
 * label or by the end of the line. A longer run of the same character is not
 * a marker of this size: git uses longer markers for conflicts nested inside
 * a recursive merge's base, and those stay part of the text.
 */

export interface Hunk {
  /** 1-based line of the opening marker. */
  start: number;
  /** 1-based line of the closing marker. */
  end: number;
  oursLabel: string;
  baseLabel: string | null;
  theirsLabel: string;
  ours: string;
  /** Null when the markers carry no base section (the default "merge" style). */
  base: string | null;
  theirs: string;
}

type Marker = "open" | "base" | "separator" | "close";

const CHAR: Record<Exclude<Marker, "separator">, string> = {
  open: "<",
  base: "|",
  close: ">",
};

/** Which marker `line` is at this marker size, if any. */
export function markerKind(rawLine: string, size: number): Marker | null {
  const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
  if (line === "=".repeat(size)) return "separator";
  for (const [kind, char] of Object.entries(CHAR) as [
    Exclude<Marker, "separator">,
    string,
  ][])
    if (
      line.startsWith(char.repeat(size)) &&
      (line.length === size || line[size] === " ")
    )
      return kind;
  return null;
}

function label(rawLine: string, size: number): string {
  return rawLine.slice(size).replace(/\r$/, "").trim();
}

/**
 * A conflict region with each section as its lines, so an empty section (no
 * lines) is told apart from one holding a single blank line.
 */
export interface RegionLines {
  start: number;
  end: number;
  oursLabel: string;
  baseLabel: string | null;
  theirsLabel: string;
  ours: string[];
  base: string[] | null;
  theirs: string[];
}

/** Every conflict region in `text`, in order, as lines. An unterminated region is left out. */
export function parseRegionLines(text: string, size = 7): RegionLines[] {
  const lines = text.split("\n");
  const regions: RegionLines[] = [];
  let current: {
    start: number;
    oursLabel: string;
    baseLabel: string | null;
    section: "ours" | "base" | "theirs";
    ours: string[];
    base: string[] | null;
    theirs: string[];
  } | null = null;
  lines.forEach((line, i) => {
    const kind = markerKind(line, size);
    if (kind === "open") {
      current = {
        start: i + 1,
        oursLabel: label(line, size),
        baseLabel: null,
        section: "ours",
        ours: [],
        base: null,
        theirs: [],
      };
      return;
    }
    if (current === null) return;
    if (kind === "base" && current.section === "ours") {
      current.section = "base";
      current.base = [];
      current.baseLabel = label(line, size);
    } else if (kind === "separator" && current.section !== "theirs") {
      current.section = "theirs";
    } else if (kind === "close" && current.section === "theirs") {
      regions.push({
        start: current.start,
        end: i + 1,
        oursLabel: current.oursLabel,
        baseLabel: current.baseLabel,
        theirsLabel: label(line, size),
        ours: current.ours,
        base: current.base,
        theirs: current.theirs,
      });
      current = null;
    } else {
      const target =
        current.section === "ours"
          ? current.ours
          : current.section === "base"
            ? (current.base ?? [])
            : current.theirs;
      target.push(line.replace(/\r$/, ""));
    }
  });
  return regions;
}

/** Every conflict region in `text`, in order. An unterminated region is left out. */
export function parseHunks(text: string, size = 7): Hunk[] {
  return parseRegionLines(text, size).map((region) => ({
    ...region,
    ours: region.ours.join("\n"),
    base: region.base === null ? null : region.base.join("\n"),
    theirs: region.theirs.join("\n"),
  }));
}

/**
 * The size of the markers git wrote into `text`: `expected` (the size the
 * attributes give) when a complete conflict region parses at it, else the
 * smallest size at which one does, since longer markers inside a region
 * belong to a recursive merge's base. Null when no region parses at any size.
 * The attribute that set the size may be gone by the time the path is mapped
 * (an ignored `.gitattributes` removed); the markers it produced are not.
 */
export function writtenMarkerSize(
  text: string,
  expected: number,
): number | null {
  const sizes = new Set<number>();
  for (const line of text.split("\n")) {
    const run = line.match(/^(<+)(?: |\r?$)/);
    if (run) sizes.add((run[1] as string).length);
  }
  const candidates = [expected, ...[...sizes].sort((a, b) => a - b)];
  return (
    candidates.find(
      (size) => sizes.has(size) && parseRegionLines(text, size).length > 0,
    ) ?? null
  );
}

/** 1-based numbers of every line that is a conflict marker of this size. */
export function markerLines(text: string, size = 7): number[] {
  const found: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (markerKind(line, size) !== null) found.push(i + 1);
  });
  return found;
}
