import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEAKY_GIT_ENV, spawnSync } from "../../../../lib/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  chainConfig,
  configAt,
  configLayer,
  hasContent,
  instructionChains,
  readDocuments,
} from "./check-instruction-chain.ts";

const script = join(import.meta.dir, "check-instruction-chain.ts");
const fixture = join(import.meta.dir, "fixtures/repo");
const scratch = mkdtempSync(join(tmpdir(), "jig-instruction-chain-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// A hook manager's git variables would point a scratch repository at the real one.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !(LEAKY_GIT_ENV as readonly string[]).includes(key.toUpperCase()),
  ),
);

function run(args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env,
    encoding: "utf8",
  });
  return {
    ...result,
    exitCode: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

let repos = 0;
function repo(files: Record<string, string>): string {
  const root = join(scratch, `repo-${repos++}`);
  mkdirSync(root);
  spawnSync("git", ["init", "-q", root], { env });
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const names = chainConfig("").names;
const chainAt = (
  documents: Record<string, string>,
  directory: string,
  list = names,
) =>
  instructionChains(new Map(Object.entries(documents)), list).find(
    (chain) => chain.directory === directory,
  );

describe("instruction chains", () => {
  test("count bytes and blank-line joins across ancestors, never siblings", () => {
    expect(
      chainAt(
        {
          "AGENTS.md": "é",
          "apps/AGENTS.md": "abc",
          "apps/web/AGENTS.md": "web",
          "docs/AGENTS.md": "docs",
        },
        "apps/web",
      ),
    ).toEqual({
      directory: "apps/web",
      files: ["AGENTS.md", "apps/AGENTS.md", "apps/web/AGENTS.md"],
      bytes: 12,
    });
  });

  test("take the override, then AGENTS.md, then a fallback name, one per directory", () => {
    const { names: withFallback } = chainConfig(
      'project_doc_fallback_filenames = ["TEAM.md"]',
    );
    const chain = chainAt(
      {
        "AGENTS.md": "normal",
        "AGENTS.override.md": "override",
        "apps/AGENTS.override.md": "app override",
        "apps/AGENTS.md": "app",
        "apps/web/TEAM.md": "fallback",
      },
      "apps/web",
      withFallback,
    );
    expect(chain?.files).toEqual([
      "AGENTS.override.md",
      "apps/AGENTS.override.md",
      "apps/web/TEAM.md",
    ]);
  });

  test.each(["", " \n\t\n"])(
    "a blank override never hides its directory's AGENTS.md: %j",
    (blank) => {
      const chain = chainAt(
        {
          "AGENTS.md": "root",
          "apps/AGENTS.override.md": blank,
          "apps/AGENTS.md": "x".repeat(40_000),
        },
        "apps",
      );
      expect(chain?.files).toEqual(["AGENTS.md", "apps/AGENTS.md"]);
      expect(chain?.bytes).toBe(4 + 2 + 40_000);
    },
  );

  test("blank is Unicode White_Space, as Rust's str::trim strips it", () => {
    expect(hasContent("\u0085\u00a0\u2028\u3000 \n")).toBe(false);
    expect(hasContent("\ufeff".repeat(3))).toBe(true);
    const chain = chainAt(
      {
        "AGENTS.md": "root",
        "apps/AGENTS.override.md": "\ufeff".repeat(11_000),
        "apps/AGENTS.md": "app",
      },
      "apps",
    );
    expect(chain?.files).toEqual(["AGENTS.md", "apps/AGENTS.override.md"]);
    expect(chain?.bytes).toBe(4 + 2 + 33_000);
  });

  test("a listed file gone from the work tree is skipped", () => {
    const root = repo({ "AGENTS.md": "root" });
    const documents = readDocuments(root, names, [
      "AGENTS.md",
      "apps/AGENTS.md",
    ]);
    expect([...documents.keys()]).toEqual(["AGENTS.md"]);
  });

  test.skipIf(process.platform === "win32")(
    "a broken instruction link fails instead of being skipped",
    () => {
      const root = repo({ "AGENTS.md": "root" });
      mkdirSync(join(root, "apps"));
      symlinkSync(join(root, "missing.md"), join(root, "apps", "AGENTS.md"));
      expect(() =>
        readDocuments(root, names, ["AGENTS.md", "apps/AGENTS.md"]),
      ).toThrow("unreadable instruction file apps/AGENTS.md");
    },
  );

  test.skipIf(process.platform === "win32").each(["fifo", "device"])(
    "an instruction entry that is not a regular file fails unread: %s",
    (kind) => {
      const root = repo({ "AGENTS.md": "root" });
      mkdirSync(join(root, "apps"));
      const target = join(root, "apps", "AGENTS.md");
      if (kind === "fifo") spawnSync("mkfifo", [target], { env });
      else symlinkSync("/dev/zero", target);
      expect(() =>
        readDocuments(root, names, ["AGENTS.md", "apps/AGENTS.md"]),
      ).toThrow(
        "unreadable instruction file apps/AGENTS.md: not a regular file",
      );
    },
  );

  test("platform separators from the file walk become forward slashes", () => {
    const root = repo({ "AGENTS.md": "root", "apps/AGENTS.md": "app" });
    const documents = readDocuments(root, names, [
      "AGENTS.md",
      "apps\\AGENTS.md",
    ]);
    expect([...documents.keys()]).toEqual(["AGENTS.md", "apps/AGENTS.md"]);
  });

  test("layers apply root first, the deepest setting winning", () => {
    const layers = new Map([
      [
        ".",
        configLayer(
          'project_doc_max_bytes = 900\nproject_doc_fallback_filenames = ["A.md"]',
        ),
      ],
      ["svc", configLayer("project_doc_max_bytes = 300")],
      ["svc/api", configLayer("project_doc_fallback_filenames = []")],
    ]);
    expect(configAt(layers, "svc")).toEqual({
      configured: 300,
      names: [...names, "A.md"],
    });
    expect(configAt(layers, "svc/api/x")).toEqual({ configured: 300, names });
    expect(configAt(layers, "web")).toEqual({
      configured: 900,
      names: [...names, "A.md"],
    });
  });

  test.each([
    "project_doc_max_bytes = 0",
    'project_doc_max_bytes = "large"',
    "project_doc_max_bytes = 1.5",
    'project_doc_fallback_filenames = "TEAM.md"',
    'project_doc_fallback_filenames = ["../TEAM.md"]',
    "invalid = [",
  ])("refuses a malformed configuration: %s", (raw) => {
    expect(() => chainConfig(raw)).toThrow();
  });
});

describe("the command", () => {
  test("the committed fixture fits, and fails a budget below its largest chain", () => {
    const config = ["--config", join(fixture, "codex-config.toml")];
    const pass = run([...config, fixture]);
    expectSpawnExit(pass, 0);
    expect(pass.output).toContain("services/billing/TEAM.md");
    const fail = run([...config, "--budget", "100", fixture]);
    expectSpawnExit(fail, 1);
    expect(fail.output).toContain("FAIL services/billing");
  });

  test("fails one byte over the configured budget and passes at it", () => {
    const root = repo({ "AGENTS.md": "root", "apps/AGENTS.md": "nested" });
    writeFileSync(join(root, "codex.toml"), "project_doc_max_bytes = 11");
    expectSpawnExit(run(["--config", join(root, "codex.toml"), root]), 1);
    writeFileSync(join(root, "codex.toml"), "project_doc_max_bytes = 12");
    expectSpawnExit(run(["--config", join(root, "codex.toml"), root]), 0);
  });

  test("a configured budget above the consumer budget does not raise the gate", () => {
    const root = repo({
      "AGENTS.md": "x".repeat(40_000),
      ".codex/config.toml": "project_doc_max_bytes = 131072",
    });
    const fail = run([root]);
    expectSpawnExit(fail, 1);
    expect(fail.output).toContain("budget: 32768 bytes (configured 131072)");
    expectSpawnExit(run(["--budget", "65536", root]), 0);
  });

  test("ignored files are not part of the repository's chains", () => {
    const root = repo({
      "AGENTS.md": "root",
      ".gitignore": "vendor/\n",
      "vendor/AGENTS.md": "x".repeat(40_000),
    });
    expectSpawnExit(run([root]), 0);
  });

  test("a nested configuration layer lowers the budget from its directory down", () => {
    const root = repo({
      "AGENTS.md": "root",
      "service/AGENTS.md": "x".repeat(100),
      "service/.codex/config.toml": "project_doc_max_bytes = 50",
      "web/AGENTS.md": "x".repeat(100),
    });
    const result = run([root]);
    expectSpawnExit(result, 1);
    expect(result.output).toContain("FAIL service: 106 > 50 bytes");
    expect(result.output).not.toContain("FAIL web");
    writeFileSync(
      join(root, "service/.codex/config.toml"),
      "project_doc_max_bytes = 106",
    );
    expectSpawnExit(run([root]), 0);
  });

  test("a nested layer's fallback names apply to its whole chain, root included", () => {
    const root = repo({
      "AGENTS.md": "",
      "TEAM.md": "x".repeat(40_000),
      "service/.codex/config.toml":
        'project_doc_fallback_filenames = ["TEAM.md"]',
    });
    const result = run([root]);
    expectSpawnExit(result, 1);
    expect(result.output).toContain("FAIL service: 40000 > 32768 bytes");
    expect(result.output).not.toContain("FAIL .:");
  });

  test("an unusable nested layer is an input error naming it", () => {
    const root = repo({
      "AGENTS.md": "root",
      "service/.codex/config.toml": "project_doc_max_bytes = 0",
    });
    const result = run([root]);
    expectSpawnExit(result, 2);
    expect(result.output).toContain(
      "unusable configuration service/.codex/config.toml",
    );
  });

  test.skipIf(process.platform === "win32")(
    "a root configuration that links to nothing is an input error, not absent",
    () => {
      const root = repo({ "AGENTS.md": "root" });
      mkdirSync(join(root, ".codex"));
      symlinkSync(join(root, "missing.toml"), join(root, ".codex/config.toml"));
      const implicit = run([root]);
      expectSpawnExit(implicit, 2);
      expect(implicit.output).toContain(
        "unusable configuration .codex/config.toml: a link to nothing",
      );
      const named = run(["--config", join(root, ".codex/config.toml"), root]);
      expectSpawnExit(named, 2);
      expect(named.output).toContain("a link to nothing");
    },
  );

  test("a named configuration that does not exist is an input error", () => {
    const missing = run(["--config", join(scratch, "absent.toml"), fixture]);
    expectSpawnExit(missing, 2);
    expect(missing.output).toContain("config not found:");
  });

  test("outside a git work tree every file under the root counts", () => {
    const root = join(scratch, "plain");
    mkdirSync(join(root, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root");
    writeFileSync(join(root, "node_modules/pkg/AGENTS.md"), "x".repeat(40_000));
    mkdirSync(join(root, "apps"));
    writeFileSync(join(root, "apps/AGENTS.md"), "x".repeat(40_000));
    const result = run([root]);
    expectSpawnExit(result, 1);
    expect(result.output).toContain("FAIL apps:");
    expect(result.output).not.toContain("node_modules");
  });

  test.skipIf(process.platform === "win32").each(["broken", "fifo", "device"])(
    "outside a git work tree an instruction entry that is not a regular file fails unread: %s",
    (kind) => {
      const root = join(scratch, `plain-${kind}`);
      mkdirSync(join(root, "apps"), { recursive: true });
      writeFileSync(join(root, "AGENTS.md"), "root");
      const target = join(root, "apps/AGENTS.md");
      if (kind === "fifo") spawnSync("mkfifo", [target], { env });
      else
        symlinkSync(
          kind === "device" ? "/dev/zero" : join(root, "missing.md"),
          target,
        );
      const result = run([root]);
      expectSpawnExit(result, 2);
      expect(result.output).toContain(
        "unreadable instruction file apps/AGENTS.md",
      );
    },
  );

  test("a repository with no root instruction file is an input error", () => {
    expectSpawnExit(run([repo({ "apps/AGENTS.md": "nested" })]), 2);
    expectSpawnExit(run(["--budget", "zero", fixture]), 2);
    expectSpawnExit(run(["--unknown"]), 2);
  });
});
