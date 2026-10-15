/**
 * The site's data, read from the repository once per build. Each function
 * reads its files on first use and keeps the result.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { type GlossaryEntry, parseGlossary } from "../glossary.ts";
import { read, repoRoot } from "../site.ts";
import { parseBrownfield, parseGreenfield } from "./adoption.ts";
import { type Criterion, parseCriteria } from "./criteria.ts";
import { parseLayers, parseTrackerInterface } from "./config.ts";
import { parseFactory } from "./factory.ts";
import { parseFlywheel } from "./flywheel.ts";
import {
  clip,
  type ModuleDoc,
  type ModuleMeta,
  parseMappings,
  parseModule,
  parseModuleIndex,
  plain,
} from "./modules.ts";
import {
  type Principle,
  parsePrinciple,
  parsePrincipleIndex,
} from "./principles.ts";
import { parseProfiles } from "./profiles.ts";
import { parseReadme } from "./readme.ts";
import { parseSkills } from "./skills.ts";
import { parseChangelog, parseRoadmap } from "./whats-new.ts";

function once<T>(load: () => T): () => T {
  let value: { v: T } | undefined;
  return () => {
    value ??= { v: load() };
    return value.v;
  };
}

export const glossary = once((): GlossaryEntry[] =>
  parseGlossary(read("GLOSSARY.md")),
);

export const modules = once((): ModuleMeta[] =>
  parseModuleIndex(read("modules/README.md")),
);

const moduleDocs = once(
  () =>
    new Map(
      modules().map((m) => [m.id, parseModule(read(`${m.dir}/README.md`))]),
    ),
);

export function moduleDoc(id: string): ModuleDoc {
  const doc = moduleDocs().get(id);
  if (!doc) throw new Error(`no module ${id}`);
  return doc;
}

/** The problem a module solves, as one plain line short enough for a popover. */
export function moduleSummary(id: string): string {
  return clip(plain(moduleDoc(id).problem), 220);
}

export function moduleMeta(id: string): ModuleMeta {
  const meta = modules().find((m) => m.id === id);
  if (!meta) throw new Error(`no module ${id}`);
  return meta;
}

export function mappingsOf(id: string) {
  return parseMappings(read(`${moduleMeta(id).dir}/mappings.md`));
}

const CRITERIA_DIR = "plugin/skills/audit/criteria";

const criteria = once(() => {
  const out = new Map<string, Criterion[]>();
  for (const f of readdirSync(join(repoRoot, CRITERIA_DIR))) {
    if (!/^M\d+-.*\.yaml$/.test(f)) continue;
    const parsed = parseCriteria(read(`${CRITERIA_DIR}/${f}`));
    out.set(parsed.module, parsed.criteria);
  }
  return out;
});

/** A module's criteria, and the file they come from. */
export function criteriaOf(id: string): { list: Criterion[]; source: string } {
  const file = readdirSync(join(repoRoot, CRITERIA_DIR)).find((f) =>
    f.startsWith(`${id}-`),
  );
  return {
    list: criteria().get(id) ?? [],
    source: file ? `${CRITERIA_DIR}/${file}` : CRITERIA_DIR,
  };
}

export const profiles = once(() =>
  parseProfiles(
    read("plugin/skills/audit/profiles.yaml"),
    read("profiles/README.md"),
    [...criteria().keys()],
  ),
);

export const principles = once((): (Principle & { file: string })[] => {
  const index = parsePrincipleIndex(read("principles/README.md"));
  return readdirSync(join(repoRoot, "principles"))
    .filter((f) => /^\d\d-.*\.md$/.test(f))
    .sort()
    .map((f) => {
      const p = parsePrinciple(read(`principles/${f}`));
      return { ...p, oneLiner: index.get(p.n) ?? "", file: `principles/${f}` };
    });
});

export const skills = once(() => parseSkills(read("plugin/README.md")));

export const factory = once(() => parseFactory(read("FACTORY.md")));

export const brownfield = once(() =>
  parseBrownfield(read("adoption/brownfield.md")),
);

export const greenfield = once(() =>
  parseGreenfield(read("adoption/greenfield.md")),
);

export const changelog = once(() => parseChangelog(read("CHANGELOG.md")));

export const roadmap = once(() => parseRoadmap(read("ROADMAP.md")));

export const flywheel = once(() =>
  parseFlywheel(read("modules/M8-learning-loop/README.md")),
);

export const layers = once(() => parseLayers(read("plugin/CONFIGURATION.md")));

export const trackerInterface = once(() =>
  parseTrackerInterface(read("plugin/README.md")),
);

export const readme = once(() => parseReadme(read("README.md")));
