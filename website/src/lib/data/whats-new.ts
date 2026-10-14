/**
 * What's new and what's next: CHANGELOG.md's releases and ROADMAP.md's open
 * items, grouped as the roadmap groups them.
 */
import { slug } from "../glossary.ts";
import { paragraphs, sections } from "../source.ts";

export interface ChangelogRelease {
  version: string;
  /** `2026-10-13`; empty for Unreleased. */
  date: string;
  unreleased: boolean;
  lead: string;
  /** `### Added`, `### Changed`, … each with its Markdown. */
  parts: { title: string; body: string }[];
}

export interface Changelog {
  intro: string[];
  releases: ChangelogRelease[];
}

export function parseChangelog(markdown: string): Changelog {
  const parts = sections(markdown);
  return {
    intro: paragraphs((parts[0]?.body ?? "").replace(/^# .+\n/, "")),
    releases: parts.slice(1).map(({ title, body }) => {
      const m = /^\[(.+?)\](?:\s*-\s*(\S+))?/.exec(title);
      const version = m?.[1] ?? title;
      const [lead, ...parts] = sections(body, 3);
      return {
        version,
        date: m?.[2] ?? "",
        unreleased: version === "Unreleased",
        lead: lead?.body ?? "",
        parts,
      };
    }),
  };
}

export interface RoadmapItem {
  /** The item's number, or empty for an unnumbered group's bullets. */
  n: string;
  title: string;
  body: string;
}

export interface RoadmapGroup {
  name: string;
  id: string;
  /** Text under the group heading before its first item. */
  intro: string;
  items: RoadmapItem[];
}

export function parseRoadmap(markdown: string): {
  intro: string;
  groups: RoadmapGroup[];
} {
  const parts = sections(markdown);
  return {
    intro: (parts[0]?.body ?? "").replace(/^# .+\n/, "").trim(),
    groups: parts.slice(1).map(({ title, body }) => {
      const [intro, ...items] = sections(body, 3);
      return {
        name: title,
        id: `rm-${slug(title)}`,
        intro: intro?.body ?? "",
        items: items.map((it) => {
          const m = /^(\d+)\.\s+(.*)$/.exec(it.title);
          return {
            n: m?.[1] ?? "",
            title: m?.[2] ?? it.title,
            body: it.body,
          };
        }),
      };
    }),
  };
}
