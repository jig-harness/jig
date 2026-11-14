/**
 * The turn-budget hook's entry in the Codex home: registered once, never
 * rewritten while its definition holds, carried through releases by a
 * pointer, and removable without touching the other hooks.
 */
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  hookCommand,
  refreshCodexHook,
  removeCodexHook,
  withHook,
  withoutHook,
} from "../codex-hook.ts";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

const pluginRoot = join(import.meta.dir, "..", "..");

/** A Codex home, a state directory and a plugin copy's hooks directory. */
function places(hooks?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "jig-codex-hook-"));
  const codexHome = join(root, "codex");
  const directory = join(root, "state", "hooks", "home");
  const pluginHooks = join(root, "release", "hooks");
  mkdirSync(codexHome);
  mkdirSync(pluginHooks, { recursive: true });
  for (const name of ["codex-shim.ts", "turn-budget-guard.ts"])
    writeFileSync(
      join(pluginHooks, name),
      readFileSync(join(pluginRoot, "hooks", name), "utf8"),
    );
  if (hooks !== undefined)
    writeFileSync(join(codexHome, "hooks.json"), JSON.stringify(hooks));
  return { root, codexHome, directory, pluginHooks };
}

function hooksOf(codexHome: string) {
  return JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
}

const other = (name: string) => ({
  hooks: [{ type: "command", command: name, timeout: 10 }],
});

test("the entry is the last PreToolUse group, so other hooks keep their position", () => {
  const document = withHook(
    {
      hooks: {
        SessionStart: [other("a")],
        PreToolUse: [other("b"), other("c")],
      },
    },
    'bun "/state/codex-turn-budget-guard.ts"',
  );
  expect(document).toEqual({
    hooks: {
      SessionStart: [other("a")],
      PreToolUse: [
        other("b"),
        other("c"),
        {
          hooks: [
            {
              type: "command",
              command: 'bun "/state/codex-turn-budget-guard.ts"',
              timeout: 15,
              statusMessage: "Counting this session's agentic turns",
            },
          ],
        },
      ],
    },
  });
});

test("an entry already there is updated in place, never added twice", () => {
  const once = withHook({}, hookCommand("/old/codex-turn-budget-guard.ts"));
  const moved = withHook(once, hookCommand("/new/codex-turn-budget-guard.ts"));
  expect(
    (moved as { hooks: { PreToolUse: unknown[] } }).hooks.PreToolUse,
  ).toHaveLength(1);
  expect(JSON.stringify(moved)).toContain("/new/");
  expect(JSON.stringify(moved)).not.toContain("/old/");
});

test("a document the entry cannot be added to is refused, not rewritten", () => {
  expect(withHook([], "x")).toBeNull();
  expect(withHook({ hooks: [] }, "x")).toBeNull();
  expect(withHook({ hooks: { PreToolUse: {} } }, "x")).toBeNull();
});

test("removing the entry leaves every other hook and drops what it empties", () => {
  const added = withHook(
    { hooks: { PreToolUse: [other("b")], Stop: [other("s")] } },
    hookCommand("/state/codex-turn-budget-guard.ts"),
  );
  expect(withoutHook(added)).toEqual({
    hooks: { PreToolUse: [other("b")], Stop: [other("s")] },
  });
  const alone = withHook({}, hookCommand("/state/codex-turn-budget-guard.ts"));
  expect(withoutHook(alone)).toEqual({ hooks: {} });
});

test("a refresh writes the entry, the shim and the pointer, and a second changes nothing", () => {
  const p = places({ hooks: { PreToolUse: [other("b")] } });
  const first = refreshCodexHook(p);
  expect(first.outcome).toBe("refreshed");
  expect(first.detail).toContain("/hooks");
  const groups = hooksOf(p.codexHome).hooks.PreToolUse;
  expect(groups).toHaveLength(2);
  expect(groups[0]).toEqual(other("b"));
  expect(groups[1].hooks[0].command).toBe(
    hookCommand(join(p.directory, "codex-turn-budget-guard.ts")),
  );
  expect(
    readFileSync(join(p.directory, "turn-budget-guard.path"), "utf8"),
  ).toBe(`${join(p.pluginHooks, "turn-budget-guard.ts")}\n`);
  expect(refreshCodexHook(p)).toMatchObject({ outcome: "unchanged" });
});

test("a release moves the pointer and leaves the registered definition as it was", () => {
  const p = places();
  refreshCodexHook(p);
  const before = readFileSync(join(p.codexHome, "hooks.json"), "utf8");
  const next = join(p.root, "next-release", "hooks");
  mkdirSync(next, { recursive: true });
  for (const name of ["codex-shim.ts", "turn-budget-guard.ts"])
    writeFileSync(
      join(next, name),
      readFileSync(join(p.pluginHooks, name), "utf8"),
    );
  const moved = refreshCodexHook({ ...p, pluginHooks: next });
  expect(moved.outcome).toBe("refreshed");
  expect(moved.detail).toContain("pointed");
  expect(moved.detail).not.toContain("registered");
  expect(readFileSync(join(p.codexHome, "hooks.json"), "utf8")).toBe(before);
});

test("no Codex home is left alone, and a hooks file that is not JSON is reported", () => {
  const p = places();
  expect(
    refreshCodexHook({ ...p, codexHome: join(p.root, "none") }),
  ).toMatchObject({ outcome: "skipped" });
  expect(existsSync(p.directory)).toBe(false);
  writeFileSync(join(p.codexHome, "hooks.json"), "{ not json");
  expect(refreshCodexHook(p)).toMatchObject({ outcome: "failed" });
  expect(readFileSync(join(p.codexHome, "hooks.json"), "utf8")).toBe(
    "{ not json",
  );
});

test("uninstall previews, then removes the entry and the shim's directory", () => {
  const p = places({ hooks: { PreToolUse: [other("b")] } });
  refreshCodexHook(p);
  expect(removeCodexHook({ ...p, confirm: false }).message).toContain(
    "is removed",
  );
  expect(hooksOf(p.codexHome).hooks.PreToolUse).toHaveLength(2);
  removeCodexHook({ ...p, confirm: true });
  expect(hooksOf(p.codexHome).hooks.PreToolUse).toEqual([other("b")]);
  expect(existsSync(p.directory)).toBe(false);
  expect(removeCodexHook({ ...p, confirm: true }).message).toContain(
    "no entry",
  );
});

test.skipIf(process.platform === "win32")(
  "the command isolates Bun's startup and quotes the path as one literal word",
  () => {
    const shim = "/home/a$b'c/state/codex-turn-budget-guard.ts";
    const command = hookCommand(shim, "linux");
    expect(command).toStartWith(
      "bun --no-env-file '--config=/home/a$b'\\''c/state/bunfig.toml' ",
    );
    expect(command).toEndWith(
      "'/home/a$b'\\''c/state/codex-turn-budget-guard.ts'",
    );
    const quoted = Bun.spawnSync([
      "sh",
      "-c",
      `printf %s ${command.slice(command.indexOf("'/home/a$b'")).split(" ").slice(-1)[0]}`,
    ]);
    expectSpawnExit(quoted, 0);
    expect(quoted.stdout.toString()).toBe(shim);
    // The entry is still recognised and removable with an apostrophe in the path.
    const added = withHook({}, command);
    expect(withoutHook(added)).toEqual({ hooks: {} });
    expect(
      (added as { hooks: { PreToolUse: unknown[] } }).hooks.PreToolUse,
    ).toHaveLength(1);
    const again = withHook(added, command) as {
      hooks: { PreToolUse: unknown[] };
    };
    expect(again.hooks.PreToolUse).toHaveLength(1);
  },
);

test("a Windows path the command cannot carry is refused", () => {
  expect(() =>
    hookCommand('C:\\a"b\\codex-turn-budget-guard.ts', "win32"),
  ).toThrow();
});

test("a handler that merely mentions the shim's name is not the entry", () => {
  const unrelated = other("echo codex-turn-budget-guard.ts");
  const added = withHook(
    { hooks: { PreToolUse: [unrelated] } },
    hookCommand("/s/codex-turn-budget-guard.ts"),
  );
  expect(
    (added as { hooks: { PreToolUse: unknown[] } }).hooks.PreToolUse,
  ).toHaveLength(2);
  expect(withoutHook(added)).toEqual({ hooks: { PreToolUse: [unrelated] } });
});

test("an empty hooks file is not JSON: reported and left alone", () => {
  const p = places();
  writeFileSync(join(p.codexHome, "hooks.json"), "  \n");
  expect(refreshCodexHook(p)).toMatchObject({ outcome: "failed" });
  expect(readFileSync(join(p.codexHome, "hooks.json"), "utf8")).toBe("  \n");
  expect(removeCodexHook({ ...p, confirm: true }).failed).toBe(true);
});

test.skipIf(process.platform === "win32")(
  "each Codex home gets its own state directory, and removal in one leaves the other",
  () => {
    const root = mkdtempSync(join(tmpdir(), "jig-codex-hook-homes-"));
    const homeA = join(root, "codex-a");
    const homeB = join(root, "codex-b");
    mkdirSync(homeA);
    mkdirSync(homeB);
    const script = join(import.meta.dir, "..", "codex-hook.ts");
    const run = (call: string, codex: string) => {
      const child = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          `const m = await import(${JSON.stringify(script)}); ${call}`,
        ],
        {
          env: {
            ...process.env,
            HOME: root,
            USERPROFILE: root,
            CODEX_HOME: codex,
          },
        },
      );
      expectSpawnExit(child, 0);
    };
    run("m.refreshCodexHook();", homeA);
    run("m.refreshCodexHook();", homeB);
    const shimDirectory = (codex: string) => {
      const command: string =
        hooksOf(codex).hooks.PreToolUse[0].hooks[0].command;
      return dirname(command.replace(/'$/, "").replace(/^.*'/, ""));
    };
    const dirA = shimDirectory(homeA);
    const dirB = shimDirectory(homeB);
    expect(dirA).not.toBe(dirB);
    expect(dirA).toStartWith(join(root, ".local"));
    run("m.removeCodexHook({ confirm: true });", homeA);
    expect(existsSync(dirA)).toBe(false);
    expect(existsSync(join(dirB, "codex-turn-budget-guard.ts"))).toBe(true);
  },
);

test("the Codex plugin ships no hooks of its own; Claude Code's registration keeps the guard", () => {
  const manifest = JSON.parse(
    readFileSync(join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  );
  expect(manifest.hooks).toBe("./hooks/codex-hooks.json");
  expect(
    JSON.parse(readFileSync(join(pluginRoot, manifest.hooks), "utf8")),
  ).toEqual({ hooks: {} });
  expect(
    readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8"),
  ).toContain("turn-budget-guard.ts");
});
