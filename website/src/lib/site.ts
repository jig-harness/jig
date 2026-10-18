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

/* What Jig is and its scope, then the steps of putting it to use, then the
   reference behind it, each deeper into the detail. */
export const NAV: readonly { label: string; href: string }[] = [
  { label: "Features", href: "/features/" },
  { label: "Factory", href: "/factory/" },
  { label: "Adopt", href: "/adopt/" },
  { label: "Modules", href: "/modules/" },
  { label: "Skills", href: "/skills/" },
  { label: "Principles", href: "/principles/" },
  { label: "Glossary", href: "/glossary/" },
];
