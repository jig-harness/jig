/**
 * Whether a skill name a repository's configuration gives resolves to a
 * skill installed where an agent would find it: the repository's own
 * project skills, the user's skills, this plugin's skills, and, for a name
 * `<plugin>:<skill>`, that enabled plugin install Claude Code records.
 *
 * A name is written as an agent invokes it: `migration-safety`,
 * `/migration-safety`, `jig:review` or `/jig:review`. A configured skill
 * that resolves to nothing is named, never dropped in silence: an agent told
 * to use it would find nothing to run.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { swallow } from "./errors.ts";

/** This plugin's name, the prefix its skills are invoked by. */
const PLUGIN_NAME = "jig";

/** A skill name's characters: no path separator, no `..`. */
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Where skills are looked for. */
export interface SkillSearch {
  /** The repository root, whose `.claude/skills` and `.agents/skills` hold its project skills. */
  root: string;
  /** Claude Code's configuration directory (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
  claudeDir: string;
  /** Codex's home (`CODEX_HOME`, else `~/.codex`). */
  codexDir: string;
  /** The user's home, whose `.agents/skills` holds skills either tool reads. */
  home: string;
  /** This plugin's `skills/` directory. */
  pluginSkills: string;
}

/** The search for `root`, from the environment and this plugin's own place. */
export function skillSearch(
  root: string,
  env: Record<string, string | undefined> = process.env,
): SkillSearch {
  const home = env.HOME ?? homedir();
  return {
    root,
    claudeDir: env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
    codexDir: env.CODEX_HOME || join(home, ".codex"),
    home,
    pluginSkills: join(import.meta.dir, "..", "skills"),
  };
}

/** `name` split into its plugin (or `null`) and skill, or `null` when it is no skill name. */
export function parseSkillName(
  name: string,
): { plugin: string | null; skill: string } | null {
  const bare = name.trim().replace(/^\//, "");
  const parts = bare.split(":");
  if (parts.length > 2) return null;
  const skill = parts.at(-1) ?? "";
  const plugin = parts.length === 2 ? (parts[0] ?? "") : null;
  if (!SKILL_NAME.test(skill)) return null;
  if (plugin !== null && !SKILL_NAME.test(plugin)) return null;
  return { plugin, skill };
}

const skillFile = (dir: string, skill: string): string | null => {
  const file = join(dir, skill, "SKILL.md");
  return existsSync(file) ? file : null;
};

const entries = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch (e) {
    swallow(e, `${dir} cannot be listed, so it holds no installed skill`);
    return [];
  }
};

/** The parsed JSON file at `path`, or `null` when it is missing or unreadable. */
function readJson(path: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch (e) {
    swallow(e, `${path} is missing or not JSON, so it records nothing`);
    return null;
  }
}

/**
 * The install directories of the enabled installs of `plugin`, from Claude
 * Code's own record (`plugins/installed_plugins.json`, less the plugins
 * `settings.json` disables), or `null` when that record is absent: only then
 * is the cache scanned.
 */
function installedPluginDirs(
  search: SkillSearch,
  plugin: string,
): string[] | null {
  const record = readJson(
    join(search.claudeDir, "plugins", "installed_plugins.json"),
  );
  const plugins = record?.plugins;
  if (typeof plugins !== "object" || plugins === null) return null;
  const enabled = readJson(
    join(search.claudeDir, "settings.json"),
  )?.enabledPlugins;
  return Object.entries(plugins)
    .filter(([id]) => id.split("@")[0] === plugin && !disabled(enabled, id))
    .flatMap(([, installs]) => installPaths(installs));
}

/** Whether `settings.json`'s `enabledPlugins` turns plugin `id` off. */
function disabled(enabled: unknown, id: string): boolean {
  return (
    typeof enabled === "object" &&
    enabled !== null &&
    (enabled as Record<string, unknown>)[id] === false
  );
}

/** The `installPath` of each install an install record lists. */
function installPaths(installs: unknown): string[] {
  if (!Array.isArray(installs)) return [];
  return installs
    .map((i: { installPath?: unknown } | null) => i?.installPath)
    .filter((p): p is string => typeof p === "string");
}

/**
 * A skill of an installed Claude Code plugin. Where Claude Code's install
 * record exists, only an enabled install answers, so a stale cached version
 * or a disabled plugin does not; without the record, any
 * `<cache>/<marketplace>/<plugin>/<version>/skills/<skill>` does.
 */
function pluginCacheSkill(
  search: SkillSearch,
  plugin: string,
  skill: string,
): string | null {
  const installed = installedPluginDirs(search, plugin);
  if (installed !== null) {
    for (const dir of installed) {
      const found = skillFile(join(dir, "skills"), skill);
      if (found !== null) return found;
    }
    return null;
  }
  const cache = join(search.claudeDir, "plugins", "cache");
  for (const marketplace of entries(cache))
    for (const version of entries(join(cache, marketplace, plugin))) {
      const found = skillFile(
        join(cache, marketplace, plugin, version, "skills"),
        skill,
      );
      if (found !== null) return found;
    }
  return null;
}

/** The `SKILL.md` the name resolves to, or `null` when nothing installed answers it. */
export function resolveSkill(name: string, search: SkillSearch): string | null {
  const parsed = parseSkillName(name);
  if (parsed === null) return null;
  const { plugin, skill } = parsed;
  if (plugin === PLUGIN_NAME) return skillFile(search.pluginSkills, skill);
  if (plugin !== null) return pluginCacheSkill(search, plugin, skill);
  for (const dir of [
    join(search.root, ".claude", "skills"),
    join(search.root, ".agents", "skills"),
    join(search.claudeDir, "skills"),
    join(search.home, ".agents", "skills"),
    join(search.codexDir, "skills"),
    search.pluginSkills,
  ]) {
    const found = skillFile(dir, skill);
    if (found !== null) return found;
  }
  return null;
}

/** The names among `names` that resolve to nothing, each once, in order. */
export function missingSkills(
  names: readonly string[],
  search: SkillSearch,
): string[] {
  return [...new Set(names)].filter((n) => resolveSkill(n, search) === null);
}
