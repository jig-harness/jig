/**
 * Facts the whole site states, read from the repository at build time so
 * they cannot drift: the plugin's version and its release date.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The repository root, given by astro.config.ts. */
export const repoRoot: string = import.meta.env.JIG_REPO_ROOT;

/** A repository file's text, by its path from the repository root. */
export function read(path: string): string {
  return readFileSync(join(repoRoot, path), "utf8");
}

export interface Release {
  version: string;
  date: string;
}

/** The current plugin version and the date of its changelog heading. */
export function currentRelease(): Release {
  const manifest: unknown = JSON.parse(
    read("plugin/.claude-plugin/plugin.json"),
  );
  const version =
    typeof manifest === "object" && manifest !== null && "version" in manifest
      ? String(manifest.version)
      : "";
  const heading = new RegExp(
    `^## \\[${version.replace(/\./g, "\\.")}\\] - (\\d{4}-\\d{2}-\\d{2})`,
    "m",
  );
  return { version, date: heading.exec(read("CHANGELOG.md"))?.[1] ?? "" };
}

export interface NavLink {
  label: string;
  href: string;
}

/** A top-level entry; a section with pages of its own lists them, its
    landing page first. */
export interface NavEntry extends NavLink {
  pages?: readonly NavLink[];
}

/* What Jig is and its scope, then the steps of putting it to use, then the
   reference behind it, each deeper into the detail. */
export const NAV: readonly NavEntry[] = [
  { label: "Features", href: "/features/" },
  {
    label: "Factory",
    href: "/factory/",
    pages: [
      { label: "Overview", href: "/factory/" },
      { label: "Scaffolding", href: "/factory/scaffolding/" },
      { label: "A · Design and planning", href: "/factory/design/" },
      { label: "B · Execution", href: "/factory/execution/" },
      { label: "Learning loop", href: "/factory/learning-loop/" },
    ],
  },
  {
    label: "Adopt",
    href: "/adopt/",
    pages: [
      { label: "Getting started", href: "/adopt/" },
      { label: "Existing repository", href: "/adopt/existing/" },
      { label: "New project", href: "/adopt/greenfield/" },
      { label: "The plugin", href: "/adopt/plugin/" },
      { label: "Configuration", href: "/adopt/configuration/" },
      { label: "Extending", href: "/adopt/extending/" },
    ],
  },
  { label: "Modules", href: "/modules/" },
  { label: "Skills", href: "/skills/" },
  { label: "Principles", href: "/principles/" },
  { label: "Glossary", href: "/glossary/" },
];
