import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../lib/guarded-git-spawn.ts";
import { digest, MANIFEST, verify } from "./integrity.ts";
import { install, type Options, type Pin } from "./install.ts";
import { release, sharedHelpers } from "./release.ts";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { render, validateOverlay, type Overlay } from "./render.ts";

const temps: string[] = [];
const temporary = () => {
  const path = realpathSync(mkdtempSync(join(tmpdir(), "installer-")));
  temps.push(path);
  return path;
};
afterEach(() => {
  for (const path of temps.splice(0))
    rmSync(path, { recursive: true, force: true });
});
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
  ),
);
const git = (path: string, ...args: string[]) => {
  const result = spawnSync("git", ["-C", path, ...args], { env });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
};
function put(root: string, file: string, content: string): void {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
const overlay = (model = "fast"): Overlay => ({
  skills: ["example"],
  gates: { command: "bun run gates" },
  harness: {
    claude_frontmatter: {
      example: { model, "allowed-tools": "Read Bash(bun *)" },
    },
    codex_frontmatter: { example: { model: "codex-example" } },
  },
});
async function fixture(helpers = false) {
  const root = temporary(),
    source = join(root, "source"),
    remote = join(root, "remote"),
    cache = join(root, "cache");
  mkdirSync(source);
  mkdirSync(remote);
  put(source, "mise.toml", '[tools]\nbun = "1.4.0"\n');
  if (helpers)
    for (const path of sharedHelpers)
      put(
        source,
        path,
        readFileSync(join(import.meta.dir, "../..", path), "utf8"),
      );
  put(
    source,
    "skills/example/SKILL.md",
    "---\nname: example\ndescription: A neutral procedure\n---\nRun {{gates.command}}.\n",
  );
  put(source, "skills/example/references/guide.md", "Reference content\n");
  put(
    source,
    "skills/example/scripts/lib/cli.ts",
    'import {realpathSync} from "node:fs"; import {resolve} from "node:path"; import {fileURLToPath} from "node:url"; export const isEntryPoint = (url: string) => Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1]!)) === fileURLToPath(url); export const runMain = (_name: string, main: () => Promise<number>) => main().then(code => {process.exitCode = code;}); export const answer = 42;',
  );
  put(
    source,
    "skills/example/scripts/main.ts",
    'import { isEntryPoint, runMain, answer } from "./lib/cli.ts"; export async function main() { console.log("answer=" + answer); return 7; } if (isEntryPoint(import.meta.url)) runMain("example", main);',
  );
  const manifest = await release(source, join(remote, "release"), "v1");
  git(remote, "init");
  git(remote, "add", ".");
  git(
    remote,
    "-c",
    "user.name=Installer Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "release",
  );
  const pin: Pin = {
    version: "v1",
    repository: remote,
    revision: git(remote, "rev-parse", "HEAD"),
    manifest,
  };
  const consumer = join(root, "consumer");
  mkdirSync(consumer);
  const options: Options = { consumer, pin, overlay: overlay(), cache };
  return {
    root,
    source,
    remote,
    cache,
    consumer,
    pin,
    options,
    cached: join(cache, `v1-${manifest}`),
  };
}

test("pinned shared helpers import and preload offline through links and copies without dependencies", async () => {
  const f = await fixture(true);
  const payload = verify(join(f.remote, "release"), f.pin.manifest);
  expect(
    payload.files
      .filter((file) => file.path.startsWith("lib/"))
      .map((file) => file.path)
      .sort(),
  ).toEqual([...sharedHelpers].sort());
  for (const copies of [false, true]) {
    const options = { ...f.options, copies, overlay: { skills: [] } };
    await install(options);
    await check(options);
    const lib = join(f.consumer, ".groundwork/lib");
    put(
      f.consumer,
      "helper-probe.ts",
      `
      import { spawnSync } from './.groundwork/lib/guarded-git-spawn.ts';
      import { expectSpawnExit } from './.groundwork/lib/test-helpers/expect-spawn-exit.ts';
      import { scopeTestTmpdir } from './.groundwork/lib/test-tmpdir.ts';
      const result = spawnSync(process.execPath, ['-e', 'console.log("shared")'], { env: process.env });
      expectSpawnExit({ ...result, exitCode: result.status }, 0);
      if (result.stdout !== 'shared\\n') throw new Error('missing output');
      const scope = scopeTestTmpdir({ prefix: 'consumer-test.' });
      scope.release();
    `,
    );
    expectSpawnExit(
      Bun.spawnSync([process.execPath, "helper-probe.ts"], {
        cwd: f.consumer,
        env,
      }),
      0,
    );
    const marker = join(f.root, `preload-root-${copies}.txt`);
    put(
      f.consumer,
      "scope-probe.test.ts",
      `
      import { test, expect } from 'bun:test';
      import { tmpdir } from 'node:os';
      import { writeFileSync, mkdtempSync } from 'node:fs';
      import { join } from 'node:path';
      test('preload contains scratch', () => {
        expect(tmpdir()).toBe(process.env.GROUNDWORK_TEST_TMPDIR);
        expect(process.env.GROUNDWORK_TEST_TMPDIR).toBeDefined();
        mkdtempSync(join(tmpdir(), 'scratch.'));
        writeFileSync(${JSON.stringify(marker)}, tmpdir());
      });
    `,
    );
    expectSpawnExit(
      Bun.spawnSync(
        [
          process.execPath,
          "test",
          "--preload",
          join(lib, "test-tmpdir-bun-preload.ts"),
          "scope-probe.test.ts",
        ],
        { cwd: f.consumer, env },
      ),
      0,
    );
    expect(existsSync(readFileSync(marker, "utf8"))).toBe(false);
    expect(existsSync(join(f.consumer, "node_modules"))).toBe(false);
    // Reinstall and check from the verified cache after its remote disappears.
    if (copies) rmSync(f.remote, { recursive: true });
    await install(options);
    await check(options);
  }
});

test("shared helper checks derive paths and bytes from the release and refuse unmanaged replacement", async () => {
  const f = await fixture(true);
  const options = { ...f.options, copies: true };
  const path = join(f.consumer, ".groundwork/lib/test-tmpdir.ts");
  put(f.consumer, ".groundwork/lib/custom.ts", "consumer-owned");
  await expect(install(options)).rejects.toThrow("unmanaged");
  expect(
    readFileSync(join(f.consumer, ".groundwork/lib/custom.ts"), "utf8"),
  ).toBe("consumer-owned");
  rmSync(join(f.consumer, ".groundwork/lib"), { recursive: true });
  await install(options);
  const original = readFileSync(path);
  writeFileSync(path, "changed");
  await expect(check(options)).rejects.toThrow("installed file changed");
  await expect(install(options)).rejects.toThrow("changed shared helpers");
  writeFileSync(path, original);
  const lockPath = join(f.consumer, ".groundwork/install.lock.json");
  const originalLock = readFileSync(lockPath, "utf8");
  const lock = JSON.parse(originalLock);
  lock.entries = lock.entries.filter(
    (entry: { path: string }) =>
      entry.path !== ".groundwork/lib/test-tmpdir.ts",
  );
  writeFileSync(lockPath, JSON.stringify(lock));
  await expect(check(options)).rejects.toThrow("missing install record");
  writeFileSync(lockPath, originalLock);
  put(f.consumer, ".groundwork/lib/extra.ts", "extra");
  await expect(check(options)).rejects.toThrow("unexpected installed entry");
  rmSync(join(f.consumer, ".groundwork/lib/extra.ts"));
  // An added empty directory has no files to validate, yet is still unmanaged.
  const stray = join(f.consumer, ".groundwork/lib/consumer-owned");
  mkdirSync(stray);
  await expect(check(options)).rejects.toThrow("unexpected installed entry");
  const pending = JSON.parse(originalLock);
  pending.pending = true;
  writeFileSync(lockPath, JSON.stringify(pending));
  await expect(install(options)).rejects.toThrow("changed shared helpers");
  expect(existsSync(stray)).toBe(true);
  writeFileSync(lockPath, originalLock);
  rmSync(stray, { recursive: true });
  await check(options);
  writeFileSync(join(f.cached, "lib/test-tmpdir.ts"), "cache tampering");
  await expect(check(options)).rejects.toThrow("release integrity mismatch");
});

test("helper installs recover pending publication and retire paths when switching to a helper-free release", async () => {
  const f = await fixture(true);
  await install(f.options);
  const lockPath = join(f.consumer, ".groundwork/install.lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.pending = true;
  lock.previous = [lock.entries];
  writeFileSync(lockPath, JSON.stringify(lock));
  await expect(check(f.options)).rejects.toThrow("interrupted");
  await install({ ...f.options, copies: true });
  await check(f.options);
  // An interruption during removal may leave only part of the previous tree.
  const partial = JSON.parse(readFileSync(lockPath, "utf8"));
  partial.pending = true;
  writeFileSync(lockPath, JSON.stringify(partial));
  rmSync(join(f.consumer, ".groundwork/lib/test-tmpdir.ts"));
  await install(f.options);
  await check(f.options);
  const noHelpers = await fixture();
  const options = {
    ...noHelpers.options,
    consumer: f.consumer,
    cache: f.cache,
    overlay: { skills: [] },
  };
  await install(options);
  await check(options);
  expect(existsSync(join(f.consumer, ".groundwork/lib"))).toBe(false);
});
const check = (options: Options) => install({ ...options, check: true });

test("two actual Git worktrees install concurrently, share one verified cache and render distinct overlays", async () => {
  const f = await fixture();
  git(f.consumer, "init");
  put(f.consumer, "README.md", "consumer\n");
  git(f.consumer, "add", ".");
  git(
    f.consumer,
    "-c",
    "user.name=Installer Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "initial",
  );
  const second = join(f.root, "second");
  git(f.consumer, "worktree", "add", "-b", "second", second);
  const two = { ...f.options, consumer: second, overlay: overlay("careful") };
  // Separate installer processes exercise the host lock, rather than serial synchronous reads in one runtime.
  for (const [path, data] of [
    [f.consumer, f.options],
    [second, two],
  ] as const) {
    put(path, ".groundwork.json", JSON.stringify(data.pin));
    put(path, "overlay.json", JSON.stringify(data.overlay));
  }
  const launch = (consumer: string) =>
    Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "install.ts"),
        "--consumer",
        consumer,
        "--overlay",
        "overlay.json",
        "--cache",
        f.cache,
      ],
      { env, stdout: "pipe", stderr: "pipe" },
    );
  const children = [launch(f.consumer), launch(second)];
  for (const child of children) {
    const status = await child.exited;
    const stderr = await new Response(child.stderr).text();
    expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  }
  await check(f.options);
  await check(two);
  expect(readdirSync(f.cache)).toEqual([`v1-${f.pin.manifest}`]);
  expect(
    readFileSync(join(f.consumer, ".claude/skills/example/SKILL.md"), "utf8"),
  ).toContain('model: "fast"');
  expect(
    readFileSync(join(second, ".claude/skills/example/SKILL.md"), "utf8"),
  ).toContain('model: "careful"');
  expect(
    git(f.consumer, "status", "--porcelain", "--untracked-files=all"),
  ).not.toContain("skills/example");
  rmSync(f.remote, { recursive: true });
  await install(f.options);
  await check(f.options); // offline reinstall
});

test("bundled scripts keep imports inline, entry detection and exit status through discovery links and copies", async () => {
  const f = await fixture();
  expect(
    existsSync(join(f.remote, "release/skills/example/scripts/lib/cli.ts")),
  ).toBe(false);
  for (const copies of [false, true]) {
    await install({ ...f.options, copies });
    await check(f.options);
    for (const surface of [".claude", ".agents"]) {
      const result = Bun.spawnSync(
        [
          process.execPath,
          join(f.consumer, surface, "skills/example/scripts/main.ts"),
        ],
        { env },
      );
      expect(result.stdout.toString()).toBe("answer=42\n");
      expect(result.exitCode).toBe(7);
    }
  }
  // Importing the bundled entry must not run its main function.
  const imported = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `await import(${JSON.stringify(join(f.cached, "skills/example/scripts/main.ts"))})`,
    ],
    { env },
  );
  expect(imported.stdout.toString()).toBe("");
  expect(imported.exitCode).toBe(0);
});

test("offline check rejects edited, missing, replaced and extra cache files plus changed manifest or mode", async () => {
  const f = await fixture();
  await install(f.options);
  const path = join(f.cached, "skills/example/references/guide.md");
  const original = readFileSync(path);
  const mutations = [
    () => writeFileSync(path, "edited"),
    () => rmSync(path),
    () => {
      rmSync(path);
      mkdirSync(path);
    },
  ];
  if (process.platform !== "win32")
    mutations.push(() => {
      rmSync(path);
      symlinkSync(
        join(f.remote, "release/skills/example/references/guide.md"),
        path,
      );
    });
  for (const mutate of mutations) {
    mutate();
    await expect(check(f.options)).rejects.toThrow();
    rmSync(path, { recursive: true, force: true });
    writeFileSync(path, original);
  }
  put(f.cached, "extra.txt", "extra");
  await expect(check(f.options)).rejects.toThrow("file set");
  rmSync(join(f.cached, "extra.txt"));
  if (process.platform !== "win32") {
    chmodSync(path, 0o755);
    await expect(check(f.options)).rejects.toThrow("integrity");
    chmodSync(path, 0o644);
    chmodSync(join(f.cached, MANIFEST), 0o755);
    await expect(check(f.options)).rejects.toThrow(
      "manifest must not be executable",
    );
    chmodSync(join(f.cached, MANIFEST), 0o644);
  }
  const manifest = readFileSync(join(f.cached, MANIFEST));
  writeFileSync(join(f.cached, MANIFEST), "{}");
  await expect(check(f.options)).rejects.toThrow("manifest digest");
  writeFileSync(join(f.cached, MANIFEST), manifest);
  await check(f.options);
});

test("adapter tampering, wrong links, overlay and selection drift fail; reinstall sweeps obsolete adapters", async () => {
  const f = await fixture();
  await install(f.options);
  const adapter = join(
    f.consumer,
    ".groundwork/adapters/claude/example/SKILL.md",
  );
  const original = readFileSync(adapter);
  for (const mutate of [
    () => writeFileSync(adapter, "edit"),
    () => rmSync(adapter),
    () => {
      rmSync(adapter);
      mkdirSync(adapter);
    },
  ]) {
    mutate();
    await expect(check(f.options)).rejects.toThrow();
    rmSync(adapter, { recursive: true, force: true });
    writeFileSync(adapter, original);
  }
  if (process.platform !== "win32") {
    chmodSync(adapter, 0o755);
    await expect(check(f.options)).rejects.toThrow("installed file changed");
    chmodSync(adapter, 0o644);
  }
  const link = join(f.consumer, ".agents/skills/example");
  rmSync(link, { recursive: true, force: true });
  cpSync(join(f.remote, "release/skills/example"), link, { recursive: true });
  await expect(check(f.options)).rejects.toThrow();
  await install(f.options);
  await expect(
    check({ ...f.options, overlay: overlay("changed") }),
  ).rejects.toThrow("inputs changed");
  put(f.consumer, ".groundwork/adapters/claude/example/extra.md", "extra");
  await expect(check(f.options)).rejects.toThrow("unexpected");
  await install(f.options);
  const empty = { ...f.options, overlay: { skills: [] } };
  await expect(check(empty)).rejects.toThrow("inputs changed");
  await install(empty);
  await check(empty);
  expect(existsSync(join(f.consumer, ".claude/skills/example"))).toBe(false);
});

test("copy fallback detects changed supporting files and extra discovery files", async () => {
  const f = await fixture();
  await install({ ...f.options, copies: true });
  await check(f.options);
  const path = join(f.consumer, ".agents/skills/example/references/guide.md");
  writeFileSync(path, "edit");
  await expect(check(f.options)).rejects.toThrow("installed file changed");
  await install({ ...f.options, copies: true });
  put(f.consumer, ".agents/skills/example/extra.md", "extra");
  await expect(check(f.options)).rejects.toThrow("unexpected");
});

test("local working tree override rebuilds without fetching and check rejects source changes", async () => {
  const f = await fixture();
  rmSync(f.remote, { recursive: true });
  const options = { ...f.options, local: f.source };
  await install(options);
  await check(options);
  put(
    f.source,
    "package.json",
    JSON.stringify({ dependencies: { "example-dependency": "2.0.0" } }),
  );
  await expect(check(options)).rejects.toThrow("local working tree changed");
  await install(options);
  await check(options);
  put(f.source, "skills/example/references/guide.md", "local change");
  await expect(check(options)).rejects.toThrow("local working tree changed");
  await install(options);
  await check(options);
  expect(
    readFileSync(
      join(f.consumer, ".agents/skills/example/references/guide.md"),
      "utf8",
    ),
  ).toBe("local change");
});

test("invalid pin, unknown skill, overlay injection, unmanaged skills and symlinked parents refuse safely", async () => {
  const f = await fixture();
  await expect(
    install({ ...f.options, pin: { ...f.pin, revision: "main" } }),
  ).rejects.toThrow("pin requires");
  await expect(
    install({ ...f.options, overlay: { skills: ["../outside"] } }),
  ).rejects.toThrow("plain names");
  await expect(
    install({ ...f.options, overlay: { skills: ["missing"] } }),
  ).rejects.toThrow();
  put(f.consumer, ".claude/skills/example/SKILL.md", "owned by consumer");
  await expect(install(f.options)).rejects.toThrow("unmanaged");
  expect(
    readFileSync(join(f.consumer, ".claude/skills/example/SKILL.md"), "utf8"),
  ).toBe("owned by consumer");
  rmSync(join(f.consumer, ".claude"), { recursive: true });
  if (process.platform !== "win32") {
    symlinkSync(f.source, join(f.consumer, ".claude"));
    await expect(install(f.options)).rejects.toThrow("real directory");
  }
  expect(() =>
    render(
      "---\nname: example\n---\nbody",
      {
        skills: ["example"],
        harness: { claude_frontmatter: { example: { name: "override" } } },
      },
      "example",
      "claude",
    ),
  ).toThrow("shadowed");
  expect(() =>
    render(
      "---\nname: example\n---\nbody",
      {
        skills: ["example"],
        harness: { claude_frontmatter: { example: { model: "bad\n---" } } },
      },
      "example",
      "claude",
    ),
  ).toThrow("invalid");
});

test("bad fetched payload is never promoted into cache", async () => {
  const f = await fixture();
  put(f.remote, "release/skills/example/references/guide.md", "tampered");
  git(f.remote, "add", ".");
  git(
    f.remote,
    "-c",
    "user.name=Installer Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "bad release",
  );
  const pin = { ...f.pin, revision: git(f.remote, "rev-parse", "HEAD") };
  await expect(install({ ...f.options, pin })).rejects.toThrow("integrity");
  expect(readdirSync(f.cache)).toEqual([]);
});

test("warm cache validates version and wrong-version supporting links fail check", async () => {
  const f = await fixture();
  await install(f.options);
  const alternate = join(f.cache, `v2-${f.pin.manifest}`);
  cpSync(f.cached, alternate, { recursive: true });
  await expect(
    install({ ...f.options, pin: { ...f.pin, version: "v2" } }),
  ).rejects.toThrow("version mismatch");
  if (process.platform !== "win32") {
    const link = join(
      f.consumer,
      ".groundwork/adapters/claude/example/references/guide.md",
    );
    rmSync(link);
    symlinkSync(join(alternate, "skills/example/references/guide.md"), link);
    await expect(check(f.options)).rejects.toThrow("wrong release link");
  }
});

test("local bundle invalidates on dependency and runtime pins", async () => {
  const f = await fixture();
  const source = join(f.root, "with-dependency");
  cpSync(f.source, source, { recursive: true });
  put(
    source,
    "package.json",
    JSON.stringify({ dependencies: { "demo-dependency": "1.0.0" } }),
  );
  put(
    source,
    "node_modules/demo-dependency/package.json",
    JSON.stringify({ name: "demo-dependency", main: "index.js" }),
  );
  put(
    source,
    "node_modules/demo-dependency/index.js",
    'export const message = "old";',
  );
  put(source, "mise.toml", '[tools]\nbun = "1.4.0"\n');
  put(
    source,
    "skills/example/scripts/dependency.ts",
    'import {message} from "demo-dependency"; if(import.meta.main) console.log(message);',
  );
  const options = { ...f.options, local: source };
  const invoke = () =>
    Bun.spawnSync(
      [
        process.execPath,
        join(f.consumer, ".agents/skills/example/scripts/dependency.ts"),
      ],
      { env },
    ).stdout.toString();
  await install(options);
  expect(invoke()).toBe("old\n");
  put(
    source,
    "package.json",
    JSON.stringify({ dependencies: { "demo-dependency": "2.0.0" } }),
  );
  put(
    source,
    "node_modules/demo-dependency/index.js",
    'export const message = "new";',
  );
  await expect(check(options)).rejects.toThrow("local working tree changed");
  await install(options);
  expect(invoke()).toBe("new\n");
  put(source, "mise.toml", '[tools]\nbun = "1.4.1"\n');
  await expect(check(options)).rejects.toThrow("local working tree changed");
  await install(options);
  await check(options);
  const lock = JSON.parse(
    readFileSync(join(f.consumer, ".groundwork/install.lock.json"), "utf8"),
  );
  expect(readFileSync(join(lock.release, "mise.toml"), "utf8")).toContain(
    'bun = "1.4.1"',
  );
});

test("bundled installer works on a host missing all ignored worktree files", async () => {
  const f = await fixture();
  put(f.consumer, ".groundwork.json", JSON.stringify(f.pin));
  put(f.consumer, "overlay.json", JSON.stringify(f.options.overlay));
  const result = Bun.spawnSync(
    [
      process.execPath,
      join(f.remote, "release/tools/install.js"),
      "--consumer",
      f.consumer,
      "--overlay",
      "overlay.json",
      "--cache",
      f.cache,
    ],
    { env },
  );
  expect({ status: result.exitCode, stderr: result.stderr.toString() }).toEqual(
    { status: 0, stderr: "" },
  );
  await check(f.options);
  expect(verify(f.cached, f.pin.manifest).version).toBe("v1");
  expect(digest(readFileSync(join(f.cached, MANIFEST)))).toBe(f.pin.manifest);
});

test("packaging validates its output and leaves nothing behind on failure", async () => {
  const f = await fixture();
  const out = join(f.root, "out");
  const variant = (name: string) => {
    const source = join(f.root, name);
    cpSync(f.source, source, { recursive: true });
    return source;
  };

  const noPin = variant("no-pin");
  rmSync(join(noPin, "mise.toml"));
  await expect(release(noPin, out, "v1")).rejects.toThrow("mise.toml");

  const clash = variant("clash");
  put(clash, "skills/example/references/Guide.md", "other\n");
  const caseSensitive = readdirSync(join(clash, "skills/example/references"));
  if (caseSensitive.length === 2)
    await expect(release(clash, out, "v1")).rejects.toThrow(
      "invalid manifest record",
    );

  const reserved = variant("reserved");
  put(reserved, "skills/example/references/nul.txt", "x\n");
  await expect(release(reserved, out, "v1")).rejects.toThrow("unsafe");

  expect(readdirSync(f.root).filter((n) => n.startsWith("out"))).toEqual([]);
  await release(variant("ok"), out, "v1");
  expect(existsSync(out)).toBe(true);
});

test("excluded fixture and dependency trees are pruned before validation", async () => {
  const f = await fixture();
  const source = join(f.root, "pruned");
  cpSync(f.source, source, { recursive: true });
  mkdirSync(join(source, "skills/example/fixtures"), { recursive: true });
  put(source, "skills/example/fixtures/data.txt", "x\n");
  if (process.platform !== "win32")
    symlinkSync("/nonexistent", join(source, "skills/example/fixtures/link"));
  await release(source, join(f.root, "pruned-out"), "v1");
  await install({ ...f.options, local: source });
  expect(existsSync(join(f.root, "pruned-out/skills/example/fixtures"))).toBe(
    false,
  );
});

test("quoted frontmatter keys count as shadowed and malformed harness mappings fail", () => {
  const source = '---\nname: x\n"model": fixed\n---\nbody\n';
  const base: Overlay = {
    skills: ["x"],
    harness: { claude_frontmatter: { x: { model: "other" } } },
  };
  expect(() => render(source, base, "x", "claude")).toThrow("shadowed");
  for (const harness of [
    false,
    { claude_frontmatter: [] },
    { codex_frontmatter: { x: false } },
  ])
    expect(() =>
      validateOverlay({ skills: ["x"], harness } as unknown),
    ).toThrow();
  expect(() => validateOverlay({ skills: ["con"] })).toThrow();
  expect(() => validateOverlay({ skills: ["com0", "com1x"] })).not.toThrow();
  expect(() => validateOverlay({ skills: ["com¹"] })).toThrow();
  expect(() =>
    render(
      '---\nname: x\n"mo\\u0064el": fixed\n---\nbody\n',
      base,
      "x",
      "claude",
    ),
  ).toThrow("unsupported key form");
  expect(() =>
    render(
      '---\nname: x\n? "model"\n: fixed\n---\nbody\n',
      base,
      "x",
      "claude",
    ),
  ).toThrow("unsupported key form");
  for (const line of [
    "!!str model: fixed",
    "&a model: fixed",
    "{model: fixed}",
  ])
    expect(() =>
      render(`---\nname: x\n${line}\n---\nbody\n`, base, "x", "claude"),
    ).toThrow("unsupported key form");
  expect(() =>
    render("---\n  name: x\n  model: fixed\n---\nbody\n", base, "x", "claude"),
  ).toThrow("unsupported key form");
  expect(
    render(
      "---\nname: x\ndescription: >\n  folded\n  text\n---\nbody\n",
      base,
      "x",
      "claude",
    ),
  ).toContain('model: "other"');
});

test("manifests reject case-folded directory and file conflicts", async () => {
  const f = await fixture();
  const manifest = verify(join(f.remote, "release"));
  const dir = join(f.root, "folded");
  cpSync(join(f.remote, "release"), dir, { recursive: true });
  const [first] = manifest.files;
  if (!first) throw new Error("fixture has no files");
  for (const extra of [
    "skills/Example/x.md",
    "skills/example/references",
    "GROUNDWORK-RELEASE.JSON",
    "Groundwork-Release.json/x",
  ]) {
    const bad = {
      ...manifest,
      files: [...manifest.files, { ...first, path: extra }],
    };
    writeFileSync(join(dir, MANIFEST), JSON.stringify(bad));
    expect(() => verify(dir)).toThrow("invalid manifest record");
  }
});

test("check derives required files from the verified release, not the lock", async () => {
  for (const copies of [false, true]) {
    const f = await fixture();
    await install({ ...f.options, copies });
    const lockPath = join(f.consumer, ".groundwork/install.lock.json");
    const original = readFileSync(lockPath, "utf8");
    const lock = JSON.parse(original) as {
      entries: { path: string; file?: { digest: string } }[];
    };
    const guide = (path: string) => path.endsWith("references/guide.md");
    // Drop every guide.md record and its file, as if the install never made them.
    for (const entry of lock.entries.filter((e) => guide(e.path)))
      rmSync(join(f.consumer, entry.path), { force: true });
    writeFileSync(
      lockPath,
      JSON.stringify({
        ...lock,
        entries: lock.entries.filter((e) => !guide(e.path)),
      }),
    );
    await expect(check(f.options)).rejects.toThrow("missing install record");
    await install({ ...f.options, copies });
    await check(f.options);
    if (copies) {
      // A copy whose recorded digest was edited along with the file still disagrees with the release.
      const relative = ".agents/skills/example/references/guide.md";
      writeFileSync(join(f.consumer, relative), "edit");
      const edited = JSON.parse(readFileSync(lockPath, "utf8")) as typeof lock;
      const entry = edited.entries.find((e) => e.path === relative);
      if (!entry?.file) throw new Error("copy record missing");
      entry.file.digest = digest("edit");
      writeFileSync(lockPath, JSON.stringify(edited));
      await expect(check(f.options)).rejects.toThrow("disagrees with release");
    }
  }
});

// Making the replacement's temp path a directory fails the .gitignore write deterministically.
const blockIgnoreWrite = (consumer: string) =>
  mkdirSync(join(consumer, `.gitignore.groundwork-${process.pid}`));
const unblockIgnoreWrite = (consumer: string) =>
  rmSync(join(consumer, `.gitignore.groundwork-${process.pid}`), {
    recursive: true,
  });

test("a failing .gitignore write keeps the original and publishes nothing; a retry succeeds", async () => {
  const f = await fixture();
  put(f.consumer, ".gitignore", "node_modules\n");
  blockIgnoreWrite(f.consumer);
  await expect(install(f.options)).rejects.toThrow();
  expect(readFileSync(join(f.consumer, ".gitignore"), "utf8")).toBe(
    "node_modules\n",
  );
  expect(existsSync(join(f.consumer, ".claude/skills/example"))).toBe(false);
  unblockIgnoreWrite(f.consumer);
  await install(f.options);
  await check(f.options);
});

test("a failed first install does not claim a skill the project creates afterwards", async () => {
  const f = await fixture();
  blockIgnoreWrite(f.consumer);
  await expect(install(f.options)).rejects.toThrow();
  unblockIgnoreWrite(f.consumer);
  put(f.consumer, ".claude/skills/example/SKILL.md", "mine\n");
  await install({ ...f.options, overlay: { skills: [] } });
  expect(
    readFileSync(join(f.consumer, ".claude/skills/example/SKILL.md"), "utf8"),
  ).toBe("mine\n");
});

type StoredLock = {
  entries: { path: string }[];
  skills: string[];
  [key: string]: unknown;
};
const readStored = (consumer: string) =>
  JSON.parse(
    readFileSync(join(consumer, ".groundwork/install.lock.json"), "utf8"),
  ) as StoredLock;
const writeStored = (consumer: string, lock: unknown) =>
  writeFileSync(
    join(consumer, ".groundwork/install.lock.json"),
    JSON.stringify(lock),
  );

test("a pending lock fails check and a retry repairs a fully published run", async () => {
  const f = await fixture();
  await install(f.options);
  const lock = readStored(f.consumer);
  writeStored(f.consumer, { ...lock, skills: [], pending: true, previous: [] });
  await expect(check(f.options)).rejects.toThrow("interrupted");
  await install(f.options);
  await check(f.options);
  expect(readStored(f.consumer).pending).toBeUndefined();
});

test("recovery never deletes a project path, even when the lock once vouched for the skill", async () => {
  const mine = ".claude/skills/example/SKILL.md";
  // Deselection interrupted after cleanup: the pending lock still lists the old install.
  const a = await fixture();
  await install(a.options);
  const old = readStored(a.consumer);
  writeStored(a.consumer, {
    ...old,
    entries: [],
    pending: true,
    previous: [old.entries],
  });
  rmSync(join(a.consumer, ".claude/skills/example"), { recursive: true });
  put(a.consumer, mine, "mine\n");
  await install({ ...a.options, overlay: { skills: [] } });
  expect(readFileSync(join(a.consumer, mine), "utf8")).toBe("mine\n");

  // A project directory holding the recorded files plus its own is not the installer's copy.
  const b = await fixture();
  await install({ ...b.options, copies: true });
  writeStored(b.consumer, {
    ...readStored(b.consumer),
    skills: [],
    pending: true,
    previous: [],
  });
  put(b.consumer, ".claude/skills/example/extra.md", "mine\n");
  await install({ ...b.options, overlay: { skills: [] } });
  expect(
    readFileSync(join(b.consumer, ".claude/skills/example/extra.md"), "utf8"),
  ).toBe("mine\n");

  // One surface is the project's: keep it, still remove the installer's other surface.
  const c = await fixture();
  await install(c.options);
  writeStored(c.consumer, {
    ...readStored(c.consumer),
    skills: [],
    pending: true,
    previous: [],
  });
  rmSync(join(c.consumer, ".claude/skills/example"), { recursive: true });
  put(c.consumer, mine, "mine\n");
  await install({ ...c.options, overlay: { skills: [] } });
  expect(readFileSync(join(c.consumer, mine), "utf8")).toBe("mine\n");
  expect(existsSync(join(c.consumer, ".agents/skills/example"))).toBe(false);
});

test("the managed ignore block survives a CRLF conversion and keeps its line endings", async () => {
  const f = await fixture();
  const ignorePath = join(f.consumer, ".gitignore");
  put(f.consumer, ".gitignore", "node_modules\n");
  await install(f.options);
  writeFileSync(
    ignorePath,
    readFileSync(ignorePath, "utf8").replaceAll("\n", "\r\n"),
  );
  await install(f.options);
  expect(
    readFileSync(ignorePath, "utf8").split("# >>> groundwork").length,
  ).toBe(2);
  await install({ ...f.options, overlay: { skills: [] } });
  const after = readFileSync(ignorePath, "utf8");
  expect(after).not.toContain("/.claude/skills/example");
  expect(after).toContain("node_modules\r\n");
  expect(after.replaceAll("\r\n", "")).not.toContain("\n");
});

test("a skill file named like the release manifest installs and checks as a copy", async () => {
  const f = await fixture();
  const source = join(f.root, "manifest-named");
  cpSync(f.source, source, { recursive: true });
  put(source, `skills/example/${MANIFEST}`, "{}\n");
  const options = { ...f.options, local: source, copies: true };
  await install(options);
  await check(options);
});

test("an interrupted publish is recovered by the next install", async () => {
  const f = await fixture();
  await install(f.options);
  // Simulate a crash after ownership was recorded but before every path was published.
  rmSync(join(f.consumer, ".claude/skills/example"), { recursive: true });
  rmSync(join(f.consumer, ".groundwork/adapters"), { recursive: true });
  await install(f.options);
  await check(f.options);
});

test("deselecting a skill retires only the ignore rules the installer added", async () => {
  const f = await fixture();
  const ignorePath = join(f.consumer, ".gitignore");
  put(f.consumer, ".gitignore", "node_modules\n/.agents/skills/example\n");
  await install(f.options);
  const installed = readFileSync(ignorePath, "utf8");
  expect(installed).toContain("/.claude/skills/example");
  await install({ ...f.options, overlay: { skills: [] } });
  const after = readFileSync(ignorePath, "utf8");
  expect(after).not.toContain("/.claude/skills/example");
  // A rule the consumer already had is theirs to keep.
  expect(after).toContain("/.agents/skills/example");
  expect(after).toContain("node_modules");
  expect(after).toContain("/.groundwork/");
  // A rule the project adds later, even a same-named one, sits outside the managed block.
  await install(f.options);
  put(
    f.consumer,
    ".gitignore",
    `${readFileSync(ignorePath, "utf8")}/.claude/skills/example\n`,
  );
  await install({ ...f.options, overlay: { skills: [] } });
  expect(readFileSync(ignorePath, "utf8")).toContain("/.claude/skills/example");
});

test("the .gitignore replacement never writes through a planted link", async () => {
  const f = await fixture();
  const victim = join(f.root, "victim.txt");
  writeFileSync(victim, "keep\n");
  put(f.consumer, ".gitignore", "node_modules\n");
  if (process.platform !== "win32") {
    symlinkSync(
      victim,
      join(f.consumer, `.gitignore.groundwork-${process.pid}`),
    );
    await expect(install(f.options)).rejects.toThrow();
    expect(readFileSync(victim, "utf8")).toBe("keep\n");
    expect(readFileSync(join(f.consumer, ".gitignore"), "utf8")).toBe(
      "node_modules\n",
    );
  }
});

test("repeated failed deselections keep the evidence for installed paths", async () => {
  const f = await fixture();
  await install(f.options);
  const empty = { ...f.options, overlay: { skills: [] } };
  blockIgnoreWrite(f.consumer);
  for (let attempt = 0; attempt < 6; attempt++)
    await expect(install(empty)).rejects.toThrow();
  unblockIgnoreWrite(f.consumer);
  await install(empty);
  await check(empty);
  expect(existsSync(join(f.consumer, ".claude/skills/example"))).toBe(false);
  expect(existsSync(join(f.consumer, ".agents/skills/example"))).toBe(false);
});

test("checkout attributes inside the pinned tree cannot alter the verified bytes", async () => {
  const f = await fixture();
  put(f.remote, ".gitattributes", "* text eol=crlf\n* ident\n");
  git(f.remote, "add", ".");
  git(
    f.remote,
    "-c",
    "user.name=Installer Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "attributes",
  );
  const pin = { ...f.pin, revision: git(f.remote, "rev-parse", "HEAD") };
  const cache = join(f.root, "fresh-cache");
  await install({ ...f.options, pin, cache });
  await check({ ...f.options, pin, cache });
});
