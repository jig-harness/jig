// @bun
// .context/release-correction-ready/tools/install/install.ts
import {
  chmodSync as chmodSync2,
  closeSync,
  cpSync,
  existsSync as existsSync2,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync3,
  mkdtempSync as mkdtempSync2,
  openSync,
  readFileSync as readFileSync4,
  readdirSync as readdirSync2,
  readlinkSync,
  renameSync as renameSync2,
  rmSync as rmSync3,
  symlinkSync,
  writeFileSync as writeFileSync3
} from "fs";
import { homedir } from "os";
import { dirname as dirname2, join as join4, resolve as resolve2 } from "path";

// .context/release-correction-ready/lib/cli.ts
function cli(run) {
  Promise.resolve().then(run).then((status) => {
    process.exitCode = status;
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  });
}

// .context/release-correction-ready/lib/guarded-git-spawn.ts
import {
  spawn as rawSpawn,
  spawnSync as rawSpawnSync
} from "child_process";
var LEAKY_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG"
];
function requireSafeEnv(env) {
  if (!env)
    throw new Error("raw spawn with no explicit env: it inherits the ambient one, which a git hook may point at the real repository. Pass an explicit safe env even for a command that does not look like git, since it may launch git indirectly (env, bash -c, a wrapper script)");
  const present = new Set(Object.entries(env).filter(([, value]) => value !== undefined).map(([key]) => key.toUpperCase()));
  const leaked = LEAKY_GIT_ENV.filter((key) => present.has(key));
  if (leaked.length > 0)
    throw new Error(`raw spawn whose env leaks ${leaked.join(", ")}: build an explicit env without them`);
}
function spawnSync(command, args, options) {
  requireSafeEnv(options?.env);
  return rawSpawnSync(command, args ?? [], {
    ...options,
    encoding: "utf8"
  });
}

// .context/release-correction-ready/tools/install/integrity.ts
import { createHash } from "crypto";
import { lstatSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
var MANIFEST = "groundwork-release.json";
var digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
var windowsUnsafeName = (name) => /^(?:con|prn|aux|nul|(?:com|lpt)[1-9\u00B9\u00B2\u00B3])(?:\..*)?$/i.test(name) || /[. ]$/.test(name);
function safePath(path) {
  if (!path || /[\\:<>"|?*]/.test(path) || [...path].some((char) => char.charCodeAt(0) < 32) || path.split("/").some((p) => !p || p === "." || p === ".." || windowsUnsafeName(p)))
    throw new Error(`unsafe release path: ${path}`);
}
function record(root, path) {
  const file = join(root, path), stat = lstatSync(file);
  if (!stat.isFile())
    throw new Error(`not a regular file: ${file}`);
  return {
    path,
    digest: digest(readFileSync(file)),
    executable: Boolean(stat.mode & 73)
  };
}
var releaseExcluded = (path) => path.split("/").some((part) => ["fixtures", "__tests__", "node_modules"].includes(part)) || path.endsWith(".test.ts");
function inventory(root, skip, includeManifest = false) {
  const files = [];
  function visit(prefix) {
    for (const entry of readdirSync(join(root, prefix), {
      withFileTypes: true
    })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (skip?.(path))
        continue;
      safePath(path);
      if (entry.isDirectory())
        visit(path);
      else if (entry.isFile()) {
        if (includeManifest || path !== MANIFEST)
          files.push(record(root, path));
      } else
        throw new Error(`release contains a link or special file: ${path}`);
    }
  }
  visit("");
  return files.sort((a, b) => a.path.localeCompare(b.path, "en"));
}
function rejectFoldedConflicts(paths) {
  const spelling = new Map, files = new Set([MANIFEST, ...paths].map((path) => path.toLowerCase()));
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1;i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/"), key = dir.toLowerCase();
      if (files.has(key) || (spelling.get(key) ?? dir) !== dir)
        throw new Error(`invalid manifest record: ${path}`);
      spelling.set(key, dir);
    }
  }
}
function verify(root, expectedDigest) {
  if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink())
    throw new Error("release root must be a real directory");
  const file = join(root, MANIFEST);
  const manifestStat = lstatSync(file);
  if (!manifestStat.isFile())
    throw new Error("manifest must be a regular file");
  if (process.platform !== "win32" && manifestStat.mode & 73)
    throw new Error("manifest must not be executable");
  const bytes = readFileSync(file);
  if (expectedDigest && digest(bytes) !== expectedDigest)
    throw new Error("release manifest digest mismatch");
  const manifest = JSON.parse(bytes.toString());
  if (manifest.schema !== 1 || typeof manifest.version !== "string" || !Array.isArray(manifest.files))
    throw new Error("invalid release manifest");
  const names = new Set;
  for (const file2 of manifest.files) {
    safePath(file2.path);
    const key = file2.path.toLowerCase();
    if (names.has(key) || key === MANIFEST.toLowerCase() || !/^[a-f0-9]{64}$/.test(file2.digest) || typeof file2.executable !== "boolean")
      throw new Error(`invalid manifest record: ${file2.path}`);
    names.add(key);
  }
  rejectFoldedConflicts(manifest.files.map((file2) => file2.path));
  const actual = inventory(root);
  if (actual.length !== manifest.files.length)
    throw new Error("release file set changed");
  const byPath = new Map(actual.map((file2) => [file2.path, file2]));
  for (const expected of manifest.files) {
    const found = byPath.get(expected.path);
    if (!found || found.digest !== expected.digest || process.platform !== "win32" && found.executable !== expected.executable)
      throw new Error(`release integrity mismatch: ${expected.path}`);
  }
  return manifest;
}

// .context/release-correction-ready/tools/install/lock.ts
import { mkdirSync, readFileSync as readFileSync2, rmSync, writeFileSync } from "fs";
import { join as join2 } from "path";
async function locked(path, run) {
  const deadline = Date.now() + 120000;
  for (;; ) {
    try {
      mkdirSync(path);
      break;
    } catch (error) {
      if (error.code !== "EEXIST")
        throw error;
      if (Date.now() > deadline) {
        let owner = "unknown owner";
        try {
          owner = readFileSync2(join2(path, "owner"), "utf8");
        } catch {}
        throw new Error(`timed out waiting for ${path} (${owner}); remove a crashed owner's lock before retrying`);
      }
      await Bun.sleep(50);
    }
  }
  try {
    writeFileSync(join2(path, "owner"), String(process.pid));
    return await run();
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
}

// .context/release-correction-ready/tools/install/render.ts
var skillName = (name) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && !windowsUnsafeName(name);
var isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
function validateOverlay(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value.skills))
    throw new Error("overlay needs a skills array");
  const skills = value.skills;
  if (skills.some((name) => typeof name !== "string" || !skillName(name)) || new Set(skills).size !== skills.length)
    throw new Error("overlay skills must be unique plain names");
  const harness = value.harness;
  if (harness === undefined)
    return;
  if (!isRecord(harness))
    throw new Error("overlay harness must be a mapping");
  for (const surface of ["claude_frontmatter", "codex_frontmatter"]) {
    const bySkill = harness[surface];
    if (bySkill === undefined)
      continue;
    if (!isRecord(bySkill))
      throw new Error(`overlay harness.${surface} must be a mapping`);
    for (const [name, fields] of Object.entries(bySkill))
      if (!isRecord(fields))
        throw new Error(`overlay harness.${surface}.${name} must be a mapping`);
  }
}
function render(source, overlay, skill, surface) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(source);
  if (!match)
    throw new Error(`${skill} needs YAML frontmatter`);
  const header = match[1] ?? "";
  const keys = new Set;
  for (const line of header.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#"))
      continue;
    if (/^\s/.test(line) && keys.size)
      continue;
    const m = /^(?:"([^"\\]+)"|'([^']+)'|([\w-]+))[ \t]*:(?:[ \t]|$)/.exec(line);
    const key = m?.[1] ?? m?.[2] ?? m?.[3];
    if (!key)
      throw new Error(`${skill} frontmatter has an unsupported key form: ${line}`);
    keys.add(key);
  }
  const injected = overlay.harness?.[`${surface}_frontmatter`]?.[skill] ?? {};
  const additions = Object.entries(injected).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    if (!/^[\w-]+$/.test(key) || keys.has(key) || typeof value !== "string" || [...value].some((char) => char.charCodeAt(0) < 32 || [127, 133, 8232, 8233].includes(char.charCodeAt(0))))
      throw new Error(`invalid or shadowed frontmatter: ${skill}.${key}`);
    return `${key}: ${JSON.stringify(value)}`;
  });
  const body = (match[2] ?? "").replace(/\{\{\s*([\w]+(?:\.[\w]+)*)\s*\}\}/g, (_whole, path) => {
    let value = overlay;
    for (const key of path.split(".")) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
        throw new Error(`missing overlay value: ${path}`);
      value = value[key];
    }
    if (typeof value === "string")
      return value;
    if (typeof value === "number" || typeof value === "boolean")
      return String(value);
    if (Array.isArray(value) && value.every((item) => typeof item === "string"))
      return value.join(", ");
    throw new Error(`overlay value is not printable: ${path}`);
  });
  return `---
${[header, ...additions].join(`
`)}
---

<!-- Generated by Groundwork; edit the source or consumer overlay. -->
${body}`;
}

// .context/release-correction-ready/tools/install/release.ts
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync as mkdirSync2,
  mkdtempSync,
  readFileSync as readFileSync3,
  renameSync,
  rmSync as rmSync2,
  writeFileSync as writeFileSync2
} from "fs";
import { dirname, join as join3, resolve } from "path";
var sharedHelpers = [
  "lib/guarded-git-spawn.ts",
  "lib/test-helpers/expect-spawn-exit.ts",
  "lib/test-tmpdir.ts",
  "lib/test-tmpdir-bun-preload.ts"
];
var typedSkills = new Set(["resolve-review-comments"]);
async function release(source, output, version) {
  source = resolve(source);
  output = resolve(output);
  if (existsSync(output))
    throw new Error(`release output already exists: ${output}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version))
    throw new Error("invalid release version");
  mkdirSync2(dirname(output), { recursive: true });
  const staging = mkdtempSync(`${output}.partial-`);
  try {
    const sum = await build(source, staging, version);
    renameSync(staging, output);
    return sum;
  } catch (error) {
    rmSync2(staging, { recursive: true, force: true });
    throw error;
  }
}
async function build(source, output, version) {
  if (!existsSync(join3(source, "mise.toml")))
    throw new Error(`release source needs mise.toml: ${source}`);
  copyFileSync(join3(source, "mise.toml"), join3(output, "mise.toml"));
  if (existsSync(join3(source, "lib")))
    for (const path of sharedHelpers) {
      const to = join3(output, path);
      mkdirSync2(dirname(to), { recursive: true });
      copyFileSync(join3(source, path), to);
      chmodSync(to, 420);
    }
  const entries = [];
  if (existsSync(join3(source, "skills"))) {
    for (const file of inventory(join3(source, "skills"), releaseExcluded)) {
      const from = join3(source, "skills", file.path), to = join3(output, "skills", file.path);
      if (file.path.endsWith(".ts")) {
        if (file.path === "resolve-review-comments/scripts/lib/yaml.ts") {
          const result = await Bun.build({
            entrypoints: [from],
            target: "bun",
            packages: "bundle",
            splitting: false
          });
          const [built] = result.outputs;
          if (!result.success || result.outputs.length !== 1 || !built)
            throw new Error(`YAML facade bundle failed: ${result.logs.join(`
`)}`);
          mkdirSync2(dirname(to), { recursive: true });
          writeFileSync2(join3(dirname(to), "yaml-runtime.js"), await built.text());
          writeFileSync2(join3(dirname(to), "yaml-runtime.d.ts"), `export function load(text: string): unknown;
`);
          writeFileSync2(to, `export { load } from "./yaml-runtime.js";
`);
          for (const path of [
            to,
            join3(dirname(to), "yaml-runtime.js"),
            join3(dirname(to), "yaml-runtime.d.ts")
          ])
            chmodSync(path, 420);
          continue;
        }
        if (typedSkills.has(file.path.split("/")[0] ?? "")) {
          mkdirSync2(dirname(to), { recursive: true });
          copyFileSync(from, to);
          chmodSync(to, file.executable ? 493 : 420);
          continue;
        }
        if (/\bif\s*\(\s*(?:import\.meta\.main|isEntryPoint\s*\()|^\s*runMain\s*\(/m.test(readFileSync3(from, "utf8")))
          entries.push(from);
        continue;
      }
      mkdirSync2(dirname(to), { recursive: true });
      copyFileSync(from, to);
      chmodSync(to, file.executable ? 493 : 420);
    }
  }
  for (const entry of entries) {
    const result = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      packages: "bundle",
      splitting: false,
      plugins: [
        {
          name: "entrypoint-guards",
          setup(build2) {
            build2.onLoad({ filter: /\.ts$/ }, (args) => {
              if (resolve(args.path) === resolve(entry))
                return;
              const text = readFileSync3(args.path, "utf8").replace(/\bisEntryPoint\s*\(\s*import\.meta\.url\s*\)|\bimport\.meta\.main/g, "false");
              return { contents: text, loader: "ts" };
            });
          }
        }
      ]
    });
    const [built] = result.outputs;
    if (!result.success || result.outputs.length !== 1 || !built)
      throw new Error(`bundle failed: ${entry}: ${result.logs.join(`
`)}`);
    const relative = entry.slice(source.length + 1), to = join3(output, relative);
    mkdirSync2(dirname(to), { recursive: true });
    writeFileSync2(to, await built.text());
    chmodSync(to, 493);
  }
  const installer = await Bun.build({
    entrypoints: [
      existsSync(join3(source, "tools/install/install.ts")) ? join3(source, "tools/install/install.ts") : join3(import.meta.dir, "install.ts")
    ],
    target: "bun",
    packages: "bundle",
    splitting: false
  });
  const [builtInstaller] = installer.outputs;
  if (!installer.success || installer.outputs.length !== 1 || !builtInstaller)
    throw new Error(`installer bundle failed: ${installer.logs.join(`
`)}`);
  mkdirSync2(join3(output, "tools"));
  writeFileSync2(join3(output, "tools/install.js"), await builtInstaller.text());
  const manifest = { schema: 1, version, files: inventory(output) };
  const bytes = `${JSON.stringify(manifest, null, 2)}
`;
  writeFileSync2(join3(output, MANIFEST), bytes);
  chmodSync(join3(output, MANIFEST), 420);
  const sum = digest(bytes);
  verify(output, sum);
  return sum;
}
if (false)
  ;

// .context/release-correction-ready/tools/install/install.ts
var present = (path) => {
  try {
    lstatSync2(path);
    return true;
  } catch (e) {
    if (e.code === "ENOENT")
      return false;
    throw e;
  }
};
function plainParents(root, path) {
  const parts = path.split("/");
  parts.pop();
  let current = root;
  for (const part of parts) {
    current = join4(current, part);
    if (present(current) && (!lstatSync2(current).isDirectory() || lstatSync2(current).isSymbolicLink()))
      throw new Error(`installation parent is not a real directory: ${current}`);
  }
}
function validatePin(pin) {
  if (!pin || typeof pin.version !== "string" || typeof pin.revision !== "string" || typeof pin.manifest !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(pin.version) || !/^[a-f0-9]{40}$/.test(pin.revision) || !/^[a-f0-9]{64}$/.test(pin.manifest) || typeof pin.repository !== "string" || !pin.repository || pin.repository.startsWith("-"))
    throw new Error("pin requires version, repository, full Git revision and SHA-256 manifest digest");
}
var defaultCache = () => join4(process.env.XDG_CACHE_HOME ?? join4(homedir(), ".cache"), "groundwork");
async function cached(options) {
  const { pin } = options;
  if (options.local) {
    const source = resolve2(options.local);
    if (existsSync2(join4(source, MANIFEST))) {
      verify(source);
      return source;
    }
    const inputs = ["skills", "lib", "tools"].flatMap((part) => existsSync2(join4(source, part)) ? inventory(join4(source, part), part === "skills" ? releaseExcluded : undefined).map((file) => ({
      ...file,
      path: `${part}/${file.path}`
    })) : []);
    for (const path3 of ["package.json", "bun.lock", "bun.lockb", "mise.toml"])
      if (existsSync2(join4(source, path3)))
        inputs.push(record(source, path3));
    const cache2 = resolve2(options.cache ?? defaultCache());
    const path2 = join4(cache2, `local-${digest(JSON.stringify(inputs))}`);
    if (present(path2)) {
      verify(path2);
      return path2;
    }
    if (options.check)
      throw new Error("local working tree changed; reinstall");
    mkdirSync3(cache2, { recursive: true });
    return locked(`${path2}.lock`, async () => {
      if (present(path2)) {
        verify(path2);
        return path2;
      }
      const temp = mkdtempSync2(join4(cache2, ".local-"));
      try {
        await release(source, join4(temp, "release"), "local");
        verify(join4(temp, "release"));
        renameSync2(join4(temp, "release"), path2);
        return path2;
      } finally {
        rmSync3(temp, { recursive: true, force: true });
      }
    });
  }
  const cache = resolve2(options.cache ?? defaultCache()), path = join4(cache, `${pin.version}-${pin.manifest}`);
  if (present(path)) {
    if (verify(path, pin.manifest).version !== pin.version)
      throw new Error("release version mismatch");
    return path;
  }
  if (options.check)
    throw new Error(`pinned release is not cached: ${path}`);
  mkdirSync3(cache, { recursive: true });
  return locked(`${path}.lock`, async () => {
    if (present(path)) {
      if (verify(path, pin.manifest).version !== pin.version)
        throw new Error("release version mismatch");
      return path;
    }
    const temp = mkdtempSync2(join4(cache, ".fetch-"));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !LEAKY_GIT_ENV.includes(key.toUpperCase())));
    const git = (args) => {
      const result = spawnSync("git", args, { env, timeout: 120000 });
      if (result.status !== 0)
        throw new Error(`release fetch failed: ${result.stderr || result.error?.message}`);
      return result.stdout.trim();
    };
    try {
      const checkout = join4(temp, "checkout");
      git(["init", checkout]);
      git(["-C", checkout, "remote", "add", "origin", pin.repository]);
      git(["-C", checkout, "fetch", "--depth=1", "origin", pin.revision]);
      const attributes = resolve2(checkout, git(["-C", checkout, "rev-parse", "--git-path", "info/attributes"]));
      mkdirSync3(dirname2(attributes), { recursive: true });
      writeFileSync3(attributes, `* -text -crlf -eol -filter -ident -working-tree-encoding
`);
      git([
        "-C",
        checkout,
        "-c",
        "core.symlinks=true",
        "-c",
        "core.autocrlf=false",
        "checkout",
        "--detach",
        "FETCH_HEAD"
      ]);
      if (git(["-C", checkout, "rev-parse", "HEAD"]) !== pin.revision)
        throw new Error("fetched wrong revision");
      const payload = join4(checkout, "release");
      if (lstatSync2(payload).isSymbolicLink())
        throw new Error("release directory is a symlink");
      const manifest = verify(payload, pin.manifest);
      if (manifest.version !== pin.version)
        throw new Error("release version mismatch");
      renameSync2(payload, path);
      return path;
    } finally {
      rmSync3(temp, { recursive: true, force: true });
    }
  });
}
var DISCOVERY_SURFACES = [".claude", ".agents"];
var IGNORE_START = "# >>> groundwork (managed block, rewritten on install) >>>";
var IGNORE_END = "# <<< groundwork <<<";
function managedIgnore(text, wanted) {
  const eol = text.includes(`\r
`) ? `\r
` : `
`, lines = text.split(/\r?\n/), start = lines.indexOf(IGNORE_START), end = start < 0 ? -1 : lines.indexOf(IGNORE_END, start + 1);
  const outside = end > start && start >= 0 ? [...lines.slice(0, start), ...lines.slice(end + 1)] : lines;
  const theirs = new Set(outside), add = wanted.filter((line) => !theirs.has(line));
  let body = outside.join(eol);
  if (!add.length)
    return body;
  if (body && !body.endsWith(eol))
    body += eol;
  return `${body}${[IGNORE_START, ...add, IGNORE_END].join(eol)}${eol}`;
}
function replaceFile(path, content) {
  const temp = `${path}.groundwork-${process.pid}`;
  let created = false;
  try {
    const fd = openSync(temp, "wx");
    created = true;
    try {
      writeFileSync3(fd, content);
    } finally {
      closeSync(fd);
    }
    if (existsSync2(path))
      chmodSync2(temp, lstatSync2(path).mode & 511);
    renameSync2(temp, path);
  } catch (error) {
    if (created)
      rmSync3(temp, { force: true });
    throw error;
  }
}
function readLock(path) {
  if (!present(path))
    return;
  const lock = JSON.parse(readFileSync4(path, "utf8"));
  if (lock.schema !== 1 || !Array.isArray(lock.skills) || lock.skills.some((name) => typeof name !== "string" || !skillName(name)) || lock.previous !== undefined && (!Array.isArray(lock.previous) || !lock.previous.every(Array.isArray)))
    throw new Error("invalid installation lock");
  return lock;
}
function carriedRecords(lock) {
  const seen = new Set;
  return [lock?.entries ?? [], ...lock?.previous ?? []].filter((records) => {
    const key = JSON.stringify(records);
    if (!records.length || seen.has(key))
      return false;
    seen.add(key);
    return true;
  });
}
function entryMatches(consumer, entry) {
  try {
    safePath(entry.path);
    const path = join4(consumer, entry.path), stat = lstatSync2(path);
    if (entry.target)
      return stat.isSymbolicLink() && resolve2(dirname2(path), readlinkSync(path)) === entry.target;
    if (!entry.file)
      return false;
    const actual = record(consumer, entry.path);
    return actual.digest === entry.file.digest && (process.platform === "win32" || actual.executable === entry.file.executable);
  } catch {
    return false;
  }
}
function exactInstall(consumer, records, path, allowMissing = false) {
  const mine = records.filter((entry) => entry.path === path || entry.path.startsWith(`${path}/`));
  if (!mine.length || !mine.every((entry) => allowMissing && !present(join4(consumer, entry.path)) ? true : entryMatches(consumer, entry)))
    return false;
  if (mine.length === 1 && mine[0]?.path === path)
    return true;
  try {
    let leaves = function(relative) {
      for (const name of readdirSync2(join4(consumer, relative))) {
        const child = `${relative}/${name}`, stat = lstatSync2(join4(consumer, child));
        if (stat.isDirectory() && !stat.isSymbolicLink() && mine.some((entry) => entry.path.startsWith(`${child}/`)))
          leaves(child);
        else
          actual.add(child);
      }
    };
    const root = join4(consumer, path);
    if (!lstatSync2(root).isDirectory())
      return false;
    const actual = new Set;
    leaves(path);
    if (allowMissing)
      return [...actual].every((leaf) => mine.some((entry) => entry.path === leaf));
    return actual.size === mine.length && mine.every((entry) => actual.has(entry.path));
  } catch {
    return false;
  }
}
function ownsDiscovery(consumer, lock, skill, surface) {
  const path = `${surface}/skills/${skill}`;
  if (!present(join4(consumer, path)))
    return true;
  if (!lock)
    return false;
  if (!lock.pending)
    return lock.skills.includes(skill);
  return [lock.entries, ...lock.previous ?? []].some((records) => exactInstall(consumer, records, path));
}
function recordedSkills(lock) {
  if (!lock)
    return [];
  const names = new Set(lock.skills);
  for (const records of [lock.entries, ...lock.previous ?? []])
    for (const entry of records) {
      const m = /^\.(?:claude|agents)\/skills\/([^/]+)/.exec(entry.path);
      if (m?.[1] && skillName(m[1]))
        names.add(m[1]);
    }
  return [...names];
}
async function install(options) {
  validatePin(options.pin);
  validateOverlay(options.overlay);
  const consumer = resolve2(options.consumer);
  if (!lstatSync2(consumer).isDirectory())
    throw new Error("consumer must be a directory");
  for (const path of [
    ".groundwork/install.lock.json",
    ".groundwork/overlay.json",
    ".claude/skills/placeholder",
    ".agents/skills/placeholder",
    ".gitignore"
  ])
    plainParents(consumer, path);
  const root = await cached(options), manifest = verify(root, options.local ? undefined : options.pin.manifest);
  const manifestDigest = digest(readFileSync4(join4(root, MANIFEST)));
  const helpers = manifest.files.filter((item) => item.path.startsWith("lib/"));
  const fingerprint = digest(JSON.stringify({
    pin: options.pin,
    overlay: options.overlay,
    local: options.local ? root : null,
    manifest: manifestDigest
  }));
  const statePath = join4(consumer, ".groundwork/install.lock.json");
  const overlayText = `${JSON.stringify(options.overlay, null, 2)}
`;
  if (present(statePath) && !lstatSync2(statePath).isFile())
    throw new Error("install lock must be a regular file");
  let old = readLock(statePath);
  const adapters = new Map;
  for (const skill of options.overlay.skills) {
    const source = readFileSync4(join4(root, "skills", skill, "SKILL.md"), "utf8");
    for (const surface of ["claude", "codex"])
      adapters.set(`${surface}/${skill}`, render(source, options.overlay, skill, surface));
  }
  if (options.check) {
    let tree = function(relative) {
      const stat = lstatSync2(join4(consumer, relative));
      if (old?.entries.some((entry) => entry.path === relative))
        return;
      if (!stat.isDirectory() || stat.isSymbolicLink() || !old?.entries.some((entry) => entry.path.startsWith(`${relative}/`)))
        throw new Error(`unexpected installed entry: ${relative}`);
      for (const name of readdirSync2(join4(consumer, relative)))
        tree(`${relative}/${name}`);
    };
    if (old?.pending)
      throw new Error("installation was interrupted; reinstall");
    if (!old || old.fingerprint !== fingerprint || old.release !== root || old.manifest !== manifestDigest)
      throw new Error("installation inputs changed; reinstall");
    const expected = [];
    const overlayPath = ".groundwork/overlay.json";
    expected.push(overlayPath);
    if (readFileSync4(join4(consumer, overlayPath), "utf8") !== overlayText)
      throw new Error("runtime overlay changed: .groundwork/overlay.json");
    for (const [key, content] of adapters) {
      const path = `.groundwork/adapters/${key}/SKILL.md`;
      expected.push(path);
      if (readFileSync4(join4(consumer, path), "utf8") !== content)
        throw new Error(`rendered adapter changed: ${path}`);
    }
    const discoveryLinks = new Set([...adapters.keys()].map((key) => {
      const [surface, skill] = key.split("/");
      return `${surface === "claude" ? ".claude" : ".agents"}/skills/${skill}`;
    }));
    for (const entry of old.entries) {
      safePath(entry.path);
      plainParents(consumer, entry.path);
      const path = join4(consumer, entry.path), stat = lstatSync2(path);
      if (entry.target) {
        if (!discoveryLinks.has(entry.path))
          throw new Error(`expected regular-file install record: ${entry.path}`);
        if (!stat.isSymbolicLink() || resolve2(dirname2(path), readlinkSync(path)) !== entry.target)
          throw new Error(`wrong release link: ${entry.path}`);
      } else if (entry.file) {
        const actual = record(consumer, entry.path);
        if (actual.digest !== entry.file.digest || process.platform !== "win32" && actual.executable !== entry.file.executable)
          throw new Error(`installed file changed: ${entry.path}`);
      } else
        throw new Error("invalid install record");
    }
    const known = new Set(expected);
    const entryAt = (path) => old?.entries.find((entry) => entry.path === path);
    const expectFile = (path, want) => {
      const entry = entryAt(path);
      if (!entry)
        throw new Error(`missing install record: ${path}`);
      known.add(path);
      if (entry.target || !entry.file)
        throw new Error(`expected regular-file install record: ${path}`);
      if (!want)
        return;
      if (entry.file?.digest !== want.digest || process.platform !== "win32" && entry.file.executable !== want.executable)
        throw new Error(`install record disagrees with release: ${path}`);
    };
    for (const item of helpers) {
      expectFile(`.groundwork/${item.path}`, item);
    }
    for (const [key, content] of adapters) {
      const [surface, skill] = key.split("/");
      const dir = `.groundwork/adapters/${key}`, prefix = `skills/${skill}/`, files = new Map([
        [
          "SKILL.md",
          {
            path: "SKILL.md",
            digest: digest(content),
            executable: false
          }
        ]
      ]);
      expectFile(`${dir}/SKILL.md`, files.get("SKILL.md"));
      for (const item of manifest.files)
        if (item.path.startsWith(prefix) && item.path !== `${prefix}SKILL.md`) {
          const rel = item.path.slice(prefix.length);
          files.set(rel, item);
          expectFile(`${dir}/${rel}`, item);
        }
      const discovery = `${surface === "claude" ? ".claude" : ".agents"}/skills/${skill}`, linked = entryAt(discovery);
      if (linked) {
        known.add(discovery);
        if (linked.target !== join4(consumer, dir))
          throw new Error(`wrong release link: ${discovery}`);
      } else
        for (const [rel, want] of files)
          expectFile(`${discovery}/${rel}`, want);
    }
    for (const entry of old.entries)
      if (!known.has(entry.path))
        throw new Error(`unexpected install record: ${entry.path}`);
    if (present(join4(consumer, ".groundwork/adapters")))
      tree(".groundwork/adapters");
    if (present(join4(consumer, ".groundwork/lib")))
      tree(".groundwork/lib");
    for (const skill of options.overlay.skills)
      for (const surface of [".claude", ".agents"])
        tree(`${surface}/skills/${skill}`);
    return;
  }
  mkdirSync3(join4(consumer, ".groundwork"), { recursive: true });
  await locked(join4(consumer, ".groundwork/install.lock"), async () => {
    old = readLock(statePath);
    const helperPath = ".groundwork/lib";
    const runtimeOverlayPath = ".groundwork/overlay.json";
    if (present(join4(consumer, runtimeOverlayPath)) && !carriedRecords(old).some((records) => exactInstall(consumer, records, runtimeOverlayPath, true)))
      throw new Error("unmanaged or changed runtime overlay; move .groundwork/overlay.json aside before reinstalling");
    if (present(join4(consumer, helperPath)) && !carriedRecords(old).some((records) => exactInstall(consumer, records, helperPath, true)))
      throw new Error("unmanaged or changed shared helpers; move .groundwork/lib aside before reinstalling");
    const ignorePath = join4(consumer, ".gitignore");
    if (present(ignorePath) && !lstatSync2(ignorePath).isFile())
      throw new Error("gitignore must be a regular file");
    for (const skill of options.overlay.skills)
      for (const surface of DISCOVERY_SURFACES)
        if (!ownsDiscovery(consumer, old, skill, surface))
          throw new Error(`unmanaged skill exists: ${join4(consumer, surface, "skills", skill)}; move it aside before adoption`);
    const entries = [];
    const stage = mkdtempSync2(join4(consumer, ".groundwork/stage-"));
    const stagedEntries = [];
    function file(path, content) {
      const dest = join4(stage, path);
      mkdirSync3(dirname2(dest), { recursive: true });
      writeFileSync3(dest, content);
      chmodSync2(dest, 420);
      stagedEntries.push({ path, file: record(stage, path) });
    }
    function copy(path, from) {
      const dest = join4(stage, path);
      mkdirSync3(dirname2(dest), { recursive: true });
      cpSync(from, dest, { recursive: true, dereference: true });
      if (lstatSync2(dest).isDirectory())
        for (const item of inventory(dest, undefined, true))
          stagedEntries.push({
            path: `${path}/${item.path}`,
            file: { ...item, path: `${path}/${item.path}` }
          });
      else
        stagedEntries.push({ path, file: record(stage, path) });
    }
    function link(path, target, from = target) {
      const dest = join4(stage, path);
      mkdirSync3(dirname2(dest), { recursive: true });
      if (!options.copies) {
        try {
          symlinkSync(target, dest, lstatSync2(from).isDirectory() ? "dir" : "file");
          stagedEntries.push({ path, target });
          return;
        } catch (e) {
          if (!["EPERM", "EACCES", "ENOSYS"].includes(e.code ?? ""))
            throw e;
        }
      }
      copy(path, from);
    }
    try {
      file(runtimeOverlayPath, overlayText);
      for (const item of helpers)
        copy(`.groundwork/${item.path}`, join4(root, item.path));
      for (const [key, content] of adapters) {
        const path = `.groundwork/adapters/${key}`;
        file(`${path}/SKILL.md`, content);
        const skill = key.split("/")[1];
        if (!skill)
          throw new Error("invalid generated adapter key");
        for (const item of manifest.files.filter((item2) => item2.path.startsWith(`skills/${skill}/`) && item2.path !== `skills/${skill}/SKILL.md`))
          copy(`${path}/${item.path.slice(`skills/${skill}/`.length)}`, join4(root, item.path));
      }
      const discovery = [];
      const stagedAdapters = stagedEntries.splice(0);
      for (const [key] of adapters) {
        const [surface, skill] = key.split("/");
        const path = `${surface === "claude" ? ".claude" : ".agents"}/skills/${skill}`;
        link(path, join4(consumer, ".groundwork/adapters", key), join4(stage, ".groundwork/adapters", key));
        discovery.push(path);
      }
      entries.push(...stagedAdapters, ...stagedEntries);
      const wanted = [
        "/.groundwork/",
        ...options.overlay.skills.flatMap((name) => [
          `/.claude/skills/${name}`,
          `/.agents/skills/${name}`
        ])
      ];
      const ignore = managedIgnore(existsSync2(ignorePath) ? readFileSync4(ignorePath, "utf8") : "", wanted);
      const writeLock = (skills, pending = false) => {
        const state = {
          schema: 1,
          fingerprint,
          release: root,
          manifest: manifestDigest,
          skills,
          entries,
          ...pending && {
            pending: true,
            previous: carriedRecords(old)
          }
        };
        writeFileSync3(join4(stage, "lock.json"), `${JSON.stringify(state, null, 2)}
`);
        renameSync2(join4(stage, "lock.json"), statePath);
      };
      writeLock(options.overlay.skills, true);
      replaceFile(ignorePath, ignore);
      for (const skill of new Set([
        ...recordedSkills(old),
        ...options.overlay.skills
      ]))
        for (const surface of DISCOVERY_SURFACES)
          if (ownsDiscovery(consumer, old, skill, surface))
            rmSync3(join4(consumer, surface, "skills", skill), {
              recursive: true,
              force: true
            });
      rmSync3(join4(consumer, ".groundwork/adapters"), {
        recursive: true,
        force: true
      });
      if (existsSync2(join4(stage, ".groundwork/adapters")))
        renameSync2(join4(stage, ".groundwork/adapters"), join4(consumer, ".groundwork/adapters"));
      rmSync3(join4(consumer, helperPath), { recursive: true, force: true });
      if (existsSync2(join4(stage, helperPath)))
        renameSync2(join4(stage, helperPath), join4(consumer, helperPath));
      renameSync2(join4(stage, runtimeOverlayPath), join4(consumer, runtimeOverlayPath));
      for (const path of discovery) {
        mkdirSync3(dirname2(join4(consumer, path)), { recursive: true });
        renameSync2(join4(stage, path), join4(consumer, path));
      }
      writeLock(options.overlay.skills);
    } finally {
      rmSync3(stage, { recursive: true, force: true });
    }
  });
}
if (import.meta.main)
  cli(async () => {
    const args = process.argv.slice(2), values = {}, flags = new Set;
    for (let i = 0;i < args.length; i++) {
      const arg = args[i] ?? "";
      const value = args[i + 1];
      if (["--check", "--copies"].includes(arg))
        flags.add(arg);
      else if (["--consumer", "--pin", "--overlay", "--cache", "--local"].includes(arg) && value && !value.startsWith("--")) {
        values[arg.slice(2)] = value;
        i++;
      } else
        throw new Error(`unknown or incomplete option: ${arg}`);
    }
    const consumer = resolve2(values.consumer ?? ".");
    const pin = JSON.parse(readFileSync4(resolve2(consumer, values.pin ?? ".groundwork.json"), "utf8"));
    if (!values.overlay)
      throw new Error("--overlay <consumer-overlay.json> is required");
    const overlay = JSON.parse(readFileSync4(resolve2(consumer, values.overlay), "utf8"));
    await install({
      consumer,
      pin,
      overlay,
      cache: values.cache,
      local: values.local ?? process.env.GROUNDWORK_LOCAL_RELEASE,
      check: flags.has("--check"),
      copies: flags.has("--copies")
    });
    console.log(flags.has("--check") ? "Groundwork installation verified" : "Groundwork installed");
    return 0;
  });
export {
  defaultCache,
  install,
  validatePin
};
