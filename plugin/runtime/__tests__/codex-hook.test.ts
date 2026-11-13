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
import { join } from "node:path";
import {
  hookCommand,
  refreshCodexHook,
  removeCodexHook,
  withHook,
  withoutHook,
} from "../codex-hook.ts";

const pluginRoot = join(import.meta.dir, "..", "..");

/** A Codex home, a state directory and a plugin copy's hooks directory. */
function places(hooks?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "jig-codex-hook-"));
  const codexHome = join(root, "codex");
  const directory = join(root, "state", "hooks");
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
  expect(removeCodexHook({ ...p, confirm: false })).toContain("is removed");
  expect(hooksOf(p.codexHome).hooks.PreToolUse).toHaveLength(2);
  removeCodexHook({ ...p, confirm: true });
  expect(hooksOf(p.codexHome).hooks.PreToolUse).toEqual([other("b")]);
  expect(existsSync(p.directory)).toBe(false);
  expect(removeCodexHook({ ...p, confirm: true })).toContain("no entry");
});

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
