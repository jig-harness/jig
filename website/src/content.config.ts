import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

// The repository's documents the site renders, read where they live. An
// entry's id is its repository path without `.md`, case kept, so a page asks
// for `modules/M2-generated-artifact-freshness/README`.
const docs = defineCollection({
  loader: glob({
    base: "..",
    pattern: [
      "README.md",
      "FACTORY.md",
      "GLOSSARY.md",
      "CHANGELOG.md",
      "ROADMAP.md",
      "adoption/*.md",
      "profiles/README.md",
      "principles/*.md",
      "modules/README.md",
      "modules/M*/README.md",
      "modules/M*/mappings.md",
      "plugin/README.md",
      "plugin/CONFIGURATION.md",
      "plugin/EXTENDING.md",
      "plugin/skills/*/SKILL.md",
      "plugin/skills/*/README.md",
      "plugin/agents/*.md",
    ],
    generateId: ({ entry }) => entry.replace(/\.md$/, ""),
  }),
});

export const collections = { docs };
