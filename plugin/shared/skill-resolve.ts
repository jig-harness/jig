/**
 * Whether a skill name a repository's configuration gives resolves to a
 * skill installed where an agent would find it: the repository's own
 * project skills, the user's skills, this plugin's skills, and, for a name
 * `<plugin>:<skill>`, that enabled plugin install Claude Code records for the repository.
 *
 * A name is written as an agent invokes it: `migration-safety`,
 * `/migration-safety`, `jig:review` or `/jig:review`. A configured skill
 * that resolves to nothing is named, never dropped in silence: an agent told
 * to use it would find nothing to run.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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
  /** Where managed settings are read from; the platform's directory when unset. */
  managedDir?: string;
  /** The platform whose settings locations apply; this process's when unset. */
  platform?: NodeJS.Platform;
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

/** A JSON object file's content, or why there is none: `absent` (no such file) or `invalid`. */
type JsonRead =
  | { status: "ok"; value: Record<string, unknown> }
  | { status: "absent" }
  | { status: "invalid" };

function readJson(path: string): JsonRead {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    swallow(e, `${path} cannot be read, so it records nothing`);
    return { status: existsSync(path) ? "invalid" : "absent" };
  }
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? { status: "ok", value: v as Record<string, unknown> }
      : { status: "invalid" };
  } catch (e) {
    swallow(e, `${path} is not JSON, so it records nothing`);
    return { status: "invalid" };
  }
}

/**
 * The main checkout of the repository holding `root`: Claude Code keeps
 * `settings.local.json` there, not in a linked worktree. `root` itself when it
 * is no linked worktree or the link cannot be read.
 */
function mainCheckout(root: string): string {
  const dotGit = join(root, ".git");
  let text: string;
  try {
    text = readFileSync(dotGit, "utf8");
  } catch (e) {
    swallow(e, `${dotGit} is no worktree link, so ${root} is its own checkout`);
    return root;
  }
  const line = text.split(/\r?\n/).find((l) => l.startsWith("gitdir:"));
  const gitdir = line?.slice("gitdir:".length).trim();
  if (!gitdir) return root;
  // A linked worktree's gitdir is `<main>/.git/worktrees/<name>`: take the
  // pair from the end, since `<name>` may itself be `worktrees`.
  const parts = resolve(root, gitdir).split(sep);
  if (parts.at(-2) !== "worktrees" || parts.at(-3) !== ".git") return root;
  return parts.slice(0, -3).join(sep) || root;
}

/** Where an organization's managed settings are read from, per platform. */
function managedSettingsDir(search: SkillSearch): string {
  if (search.managedDir !== undefined) return search.managedDir;
  const platform = search.platform ?? process.platform;
  if (platform === "darwin") return "/Library/Application Support/ClaudeCode";
  if (platform === "win32") return "C:\\Program Files\\ClaudeCode";
  return "/etc/claude-code";
}

/**
 * Managed enablement of `id`: `managed-settings.json`, then the files of
 * `managed-settings.d` in alphabetical order, the last that names it winning.
 */
function managedEnablement(
  search: SkillSearch,
  id: string,
): boolean | undefined {
  const dir = managedSettingsDir(search);
  const dropIns = entries(join(dir, "managed-settings.d"))
    .filter((f) => !f.startsWith(".") && f.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => join(dir, "managed-settings.d", f));
  let result: boolean | undefined;
  for (const file of [join(dir, "managed-settings.json"), ...dropIns])
    result = enablement(file, id) ?? result;
  return result;
}

/** `enabledPlugins[id]` in the settings file at `file`, or `undefined` when it says nothing. */
function enablement(file: string, id: string): boolean | undefined {
  const read = readJson(file);
  if (read.status !== "ok") return undefined;
  const enabled = read.value.enabledPlugins;
  if (typeof enabled !== "object" || enabled === null) return undefined;
  const setting = (enabled as Record<string, unknown>)[id];
  return typeof setting === "boolean" ? setting : undefined;
}

/** Where `settings.local.json` lives: the main checkout, except on Windows, which keeps it in the worktree. */
const localSettingsRoot = (search: SkillSearch): string =>
  (search.platform ?? process.platform) === "win32"
    ? search.root
    : mainCheckout(search.root);

/**
 * Whether plugin `id` is turned off for `search.root`. Managed settings
 * decide first; otherwise the last of the user's `settings.json`, the
 * repository's `.claude/settings.json` and the `.claude/settings.local.json`
 * of its main checkout that names it. An unreadable layer counts as turning
 * nothing off.
 */
function disabled(search: SkillSearch, id: string): boolean {
  const managed = managedEnablement(search, id);
  if (managed !== undefined) return !managed;
  let off = false;
  for (const file of [
    join(search.claudeDir, "settings.json"),
    join(search.root, ".claude", "settings.json"),
    join(localSettingsRoot(search), ".claude", "settings.local.json"),
  ]) {
    const setting = enablement(file, id);
    if (setting !== undefined) off = !setting;
  }
  return off;
}

/** Whether `rel`, a relative path, stays inside its origin. */
const inside = (rel: string): boolean =>
  rel === "" ||
  (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));

/**
 * Whether an install record applies to `search.root`: user-wide (`user`, or no
 * scope) or `managed`, or scoped (`project`, `local`) to a directory holding
 * it or its main checkout. Any other
 * scope, or a scoped install without a project path, applies nowhere.
 */
function appliesHere(install: unknown, search: SkillSearch): boolean {
  const i = install as { scope?: unknown; projectPath?: unknown } | null;
  if (i === null || typeof i !== "object") return false;
  if (i.scope === undefined || i.scope === "user" || i.scope === "managed")
    return true;
  if (i.scope !== "project" && i.scope !== "local") return false;
  if (typeof i.projectPath !== "string" || i.projectPath === "") return false;
  const project = resolve(i.projectPath);
  // A project install is shared with every worktree of its repository.
  return [search.root, mainCheckout(search.root)].some((r) =>
    inside(relative(project, resolve(r))),
  );
}

/**
 * The install directories of the enabled installs of `plugin` that apply to
 * `search.root`, from Claude Code's own record
 * (`plugins/installed_plugins.json`), or `null` when that record is absent:
 * only then is the cache scanned. A record that cannot be read or is not the
 * expected shape answers nothing.
 */
function installedPluginDirs(
  search: SkillSearch,
  plugin: string,
): string[] | null {
  const record = readJson(
    join(search.claudeDir, "plugins", "installed_plugins.json"),
  );
  if (record.status === "absent") return null;
  if (record.status === "invalid") return [];
  const plugins = record.value.plugins;
  if (typeof plugins !== "object" || plugins === null) return [];
  return Object.entries(plugins)
    .filter(([id]) => id.split("@")[0] === plugin && !disabled(search, id))
    .flatMap(([, installs]) => installPaths(installs, search));
}

/** The `installPath` of each install an install record lists that applies here. */
function installPaths(installs: unknown, search: SkillSearch): string[] {
  if (!Array.isArray(installs)) return [];
  return installs
    .filter((i) => appliesHere(i, search))
    .map((i: { installPath?: unknown }) => i.installPath)
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
