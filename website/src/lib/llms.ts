/**
 * The site's `llms.txt` files, for coding agents that read text rather than
 * pages (https://llmstxt.org): a root index and one file per section, each a
 * title, a one-line summary and a list of links with a line on each page.
 *
 * Lists of modules, skills and principles come from the parsers; the few
 * fixed pages of a section, its overview among them, are named here with the
 * description their page carries. Every link is checked against the built site (`check-links.ts`).
 * The glossary is not included: it is large, and most of it is not about Jig.
 */
import { plain } from "./data/modules.ts";
import { SITE_ORIGIN } from "./origin.ts";
import { firstParagraph } from "./source.ts";

export interface Link {
  title: string;
  /** A route on the site, `/modules/M2/`. */
  route: string;
  note: string;
}

export interface LlmsFile {
  title: string;
  summary: string;
  /** Plain paragraphs after the summary. */
  intro?: string;
  groups: { heading: string; links: Link[] }[];
}

/** One entry in the root index: a section and what its own file lists. */
export interface SectionEntry {
  /** `modules`: the file is `/modules/llms.txt`. */
  slug: string;
  title: string;
  /** The section file's own summary line. */
  summary: string;
  /** The root index's line on it. */
  note: string;
}

export const SECTIONS: readonly SectionEntry[] = [
  {
    slug: "modules",
    summary:
      "Jig's practice modules: each states one practice, with three levels, mappings per ecosystem and audit criteria.",
    title: "Modules",
    note: "the practices, each with its three levels, mappings and criteria",
  },
  {
    slug: "skills",
    summary: "The skills and agent of the Jig plugin, and what each does.",
    title: "Skills",
    note: "the plugin's skills and agent, and what each runs",
  },
  {
    slug: "principles",
    summary: "The principles behind every Jig module.",
    title: "Principles",
    note: "the principles behind every module",
  },
  {
    slug: "factory",
    summary:
      "Jig as a software factory: the scaffolding a factory of agents runs on, and its stations.",
    title: "Software factory",
    note: "the scaffolding, the design pipeline, the work-item line and the learning loop",
  },
  {
    slug: "adopt",
    summary: "How to adopt Jig in an existing repository or a new project.",
    title: "Adopt",
    note: "adopting Jig in an existing repository or a new project",
  },
  {
    slug: "plugin",
    summary: "How to install, configure and extend the Jig plugin.",
    title: "Plugin",
    note: "installing, configuring and extending the Jig plugin",
  },
];

/** Pages that belong to no section's file, listed in the root index. */
const ROOT_PAGES: readonly Link[] = [
  {
    title: "What you get",
    route: "/features/",
    note: "what a team can run, install or copy from Jig today, and what is on the roadmap",
  },
  {
    title: "What's new",
    route: "/whats-new/",
    note: "every release of the jig plugin, and the open roadmap",
  },
];

/** The pages of each section that are not one-per-module, skill or principle. */
export const FIXED_PAGES: Readonly<Record<string, readonly Link[]>> = {
  modules: [
    {
      title: "The module map",
      route: "/modules/",
      note: "every module, its three levels, and how much of them each profile needs",
    },
  ],
  skills: [
    {
      title: "Skills",
      route: "/skills/",
      note: "the skills that run Jig's modules for you, and the stations no skill runs",
    },
  ],
  principles: [
    {
      title: "Principles",
      route: "/principles/",
      note: "the principles behind every module",
    },
  ],
  factory: [
    {
      title: "Jig as a software factory",
      route: "/factory/",
      note: "what Jig provides to build the scaffolding a factory of agents runs on, and the stations that stand on it",
    },
    {
      title: "The scaffolding",
      route: "/factory/scaffolding/",
      note: "the jobs a repository's scaffolding does, the modules that build each, and what Jig provides",
    },
    {
      title: "Design and planning",
      route: "/factory/design/",
      note: "the feature pipeline, from research to an epic of planned work items",
    },
    {
      title: "Execution",
      route: "/factory/execution/",
      note: "the work-item line and the pull-request loop every change follows",
    },
    {
      title: "The learning loop",
      route: "/factory/learning-loop/",
      note: "how a miss a station should have caught becomes a validated check",
    },
  ],
  adopt: [
    {
      title: "Adopt Jig in an existing repository",
      route: "/adopt/",
      note: "decide how far to go, then climb one rung at a time: the audit, the ladder and the profiles",
    },
    {
      title: "Adopt Jig in a new project",
      route: "/adopt/greenfield/",
      note: "run the kickoff, and hand each phase to the module that governs it",
    },
  ],
  plugin: [
    {
      title: "Install and configure the plugin",
      route: "/plugin/",
      note: "requirements, install, first use and configuration",
    },
    {
      title: "Configuration",
      route: "/plugin/configuration/",
      note: "every field of a repository's Jig configuration, and the layers it is read from",
    },
    {
      title: "Extending and adapting Jig",
      route: "/plugin/extending/",
      note: "what a repository adapts with a value, a command of its own or an implementation in Jig",
    },
  ],
};

/** The file's route: `/llms.txt`, or `/modules/llms.txt` for a section. */
const llmsRoute = (slug?: string): string =>
  slug ? `/${slug}/llms.txt` : "/llms.txt";

/** A page's link is its Markdown twin (`/modules/M2/` -> `.../index.md`); a file is itself. */
const url = (route: string): string =>
  `${SITE_ORIGIN}${route.endsWith("/") ? `${route}index.md` : route}`;

const item = (l: Link): string =>
  `- [${l.title}](${url(l.route)})${l.note ? `: ${l.note}` : ""}`;

/** The Markdown text of a file. */
export function render(file: LlmsFile): string {
  const out = [`# ${file.title}`, "", `> ${file.summary}`];
  if (file.intro) out.push("", file.intro);
  for (const g of file.groups)
    out.push("", `## ${g.heading}`, "", ...g.links.map(item));
  return `${out.join("\n")}\n`;
}

/** README's bold tagline and opening paragraph: what Jig is. */
export function readmeLead(readme: string): { summary: string; intro: string } {
  const tagline = /^\*\*(.+?)\*\*\s*$/m.exec(readme)?.[1] ?? "Jig";
  const after = readme.slice(readme.indexOf(tagline) + tagline.length);
  return {
    summary: plain(tagline).replace(/\.$/, ""),
    intro: plain(firstParagraph(after.replace(/^\*\*\s*/, ""))),
  };
}

/** The root index: what Jig is, and a link to each section's file. */
export function rootFile(summary: string, intro: string): LlmsFile {
  return {
    title: "Jig",
    summary,
    intro: `${intro} Each section below has its own llms.txt listing its pages. Every page is also served as Markdown, at its address with index.md added or to a request that asks for text/markdown.`,
    groups: [
      {
        heading: "Sections",
        links: SECTIONS.map((s) => ({
          title: s.title,
          route: llmsRoute(s.slug),
          note: s.note,
        })),
      },
      { heading: "Pages", links: [...ROOT_PAGES] },
    ],
  };
}
