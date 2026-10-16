/**
 * Each `llms.txt` file's content, read from the repository's documents
 * through the site's parsers. The text layout is in llms.ts.
 */
import { modules, principles, skills } from "./data/index.ts";
import { clip, plain } from "./data/modules.ts";
import {
  FIXED_PAGES,
  type LlmsFile,
  type Link,
  readmeLead,
  rootFile,
  SECTIONS,
  type SectionEntry,
} from "./llms.ts";
import { read } from "./site.ts";

const moduleLinks = (): Link[] =>
  modules().map((m) => ({
    title: `${m.id} ${m.title}`,
    route: `/modules/${m.id}/`,
    note: plain(m.area),
  }));

const mappingLinks = (): Link[] =>
  modules().map((m) => ({
    title: `${m.id} ${m.title}: mappings`,
    route: `/modules/${m.id}/mappings/`,
    note: "the practice in each ecosystem's tools",
  }));

const skillLinks = (): Link[] =>
  skills().map((s) => ({
    title: s.command,
    route: `/skills/${s.name}/`,
    note: clip(plain(s.purpose), 220),
  }));

/**
 * The agent's contract of each skill whose main page is its human guide
 * (the skill has a README), as `skills/[name]/skill.astro` generates them.
 */
const contractLinks = (): Link[] =>
  skills()
    .filter((s) => s.source.endsWith("/README.md"))
    .map((s) => ({
      title: `${s.command}: the agent's contract`,
      route: `/skills/${s.name}/skill/`,
      note: `the procedure an agent follows when it runs ${s.name}`,
    }));

const principleLinks = (): Link[] =>
  principles().map((p) => ({
    title: `${p.n} ${p.title}`,
    route: `/principles/${p.n}/`,
    note: clip(plain(p.oneLiner), 220),
  }));

/** The section files' entries, one per file. */
export const sections = (): readonly SectionEntry[] => SECTIONS;

export function root(): LlmsFile {
  const { summary, intro } = readmeLead(read("README.md"));
  return rootFile(summary, intro);
}

/** The groups of links a section's file lists, by section. */
const GROUPS: Record<string, () => LlmsFile["groups"]> = {
  modules: () => [
    { heading: "Overview", links: [...(FIXED_PAGES.modules ?? [])] },
    { heading: "Modules", links: moduleLinks() },
    { heading: "Mappings", links: mappingLinks() },
  ],
  skills: () => [
    { heading: "Overview", links: [...(FIXED_PAGES.skills ?? [])] },
    { heading: "Skills", links: skillLinks() },
    { heading: "Agent contracts", links: contractLinks() },
  ],
  principles: () => [
    { heading: "Overview", links: [...(FIXED_PAGES.principles ?? [])] },
    { heading: "Principles", links: principleLinks() },
  ],
};

export function section(meta: SectionEntry): LlmsFile {
  const groups = GROUPS[meta.slug]?.() ?? [
    { heading: "Pages", links: [...(FIXED_PAGES[meta.slug] ?? [])] },
  ];
  return { title: `Jig: ${meta.title}`, summary: meta.summary, groups };
}
