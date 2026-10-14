/**
 * The modules: the index in modules/README.md, each module's README in the
 * parts its page lays out, and its mappings.md by tool family.
 */
import {
  blocks,
  firstParagraph,
  listItems,
  type Section,
  sections,
  tableRows,
  titleLine,
  withoutTitle,
} from "../source.ts";

export const LEVELS = ["lite", "standard", "strict"] as const;
export type Level = (typeof LEVELS)[number];
export const LEVEL_NAME: Record<Level, string> = {
  lite: "Lite",
  standard: "Standard",
  strict: "Strict",
};

export interface ModuleMeta {
  /** `M2` */
  id: string;
  title: string;
  /** `modules/M2-generated-artifact-freshness` */
  dir: string;
  /** The practice area, Markdown. */
  area: string;
  /** The skills and agents that run the practice, by name. */
  skills: string[];
}

/** The module index: one row per module in modules/README.md's table. */
export function parseModuleIndex(markdown: string): ModuleMeta[] {
  return tableRows(markdown).flatMap(([name = "", area = "", runs = ""]) => {
    const m = /^\[(M\d+) ([^\]]+)\]\(([^)]+)\)$/.exec(name);
    if (!m?.[1] || !m[2] || !m[3]) return [];
    return [
      {
        id: m[1],
        title: m[2],
        dir: `modules/${m[3].replace(/\/$/, "")}`,
        area,
        skills: [...runs.matchAll(/\[`([a-z-]+)`\]/g)].map((x) => x[1] ?? ""),
      },
    ];
  });
}

export interface BodySection extends Section {
  /** The section's first paragraph, plain and clipped: its one-line lead. */
  lead: string;
}

export interface ModuleDoc {
  title: string;
  /** The opening paragraph, without its "What problem this solves." label. */
  problem: string;
  /** The invariant's quoted rule. */
  invariant: string;
  /** What the Invariant section says beyond the rule. */
  invariantNotes: string;
  levels: Record<Level, string>;
  /** What the Maturity levels section says beyond the three levels. */
  levelNotes: string;
  steps: string;
  status: string;
  /** Every other section: the module's mechanics. */
  body: BodySection[];
}

const plain = (md: string) =>
  md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

function clip(text: string, max: number): string {
  return text.length > max
    ? `${text.slice(0, max - 4).replace(/\s+\S*$/, "")}…`
    : text;
}

function parseLevels(body: string): {
  levels: Record<Level, string>;
  notes: string;
} {
  const levels: Record<Level, string> = { lite: "", standard: "", strict: "" };
  for (const item of listItems(body)) {
    const m = /^\*\*(Lite|Standard|Strict)\*\*\s+—\s+([\s\S]*)$/.exec(
      item.body,
    );
    if (m?.[1] && m[2]) levels[m[1].toLowerCase() as Level] = m[2];
  }
  const notes = blocks(body)
    .filter((b) => !/^- \*\*(Lite|Standard|Strict)\*\*/.test(b))
    .join("\n\n");
  return { levels, notes };
}

export function parseModule(markdown: string): ModuleDoc {
  const parts = sections(markdown);
  const intro = withoutTitle(parts[0]?.body ?? "");
  const doc: ModuleDoc = {
    title: titleLine(markdown),
    problem: firstParagraph(intro).replace(
      /^\*\*What problem this solves\.\*\*\s*/,
      "",
    ),
    invariant: "",
    invariantNotes: "",
    levels: { lite: "", standard: "", strict: "" },
    levelNotes: "",
    steps: "",
    status: "",
    body: [],
  };
  for (const { title, body } of parts.slice(1)) {
    if (title === "Invariant") {
      const lines = body.split("\n");
      doc.invariant = lines
        .filter((l) => l.startsWith(">"))
        .map((l) => l.replace(/^>\s?/, ""))
        .join("\n");
      doc.invariantNotes = lines
        .filter((l) => !l.startsWith(">"))
        .join("\n")
        .trim();
    } else if (title === "Maturity levels") {
      const { levels, notes } = parseLevels(body);
      doc.levels = levels;
      doc.levelNotes = notes;
    } else if (title === "Adoption steps") doc.steps = body;
    else if (title === "Status") doc.status = body;
    else
      doc.body.push({
        title,
        body,
        lead: clip(plain(firstParagraph(body)), 190),
      });
  }
  return doc;
}

export interface MappingPart {
  title: string;
  /** The CI provider the part is about, when it is one, for the stack switch. */
  ci: string | null;
  body: string;
}

export interface MappingSection {
  title: string;
  intro: string;
  parts: MappingPart[];
}

const CI_PROVIDERS = ["GitHub Actions", "GitLab CI"];

/** A mappings.md: its introduction and its level-two sections, split by tool. */
export function parseMappings(markdown: string): {
  intro: string;
  sections: MappingSection[];
} {
  const parts = sections(markdown);
  return {
    intro: withoutTitle(parts[0]?.body ?? ""),
    sections: parts.slice(1).map(({ title, body }) => {
      const [intro, ...rest] = sections(body, 3);
      return {
        title,
        intro: intro?.body ?? "",
        parts: rest.map((p) => ({
          title: p.title,
          ci: CI_PROVIDERS.find((c) => p.title.startsWith(c)) ?? null,
          body: p.body,
        })),
      };
    }),
  };
}
