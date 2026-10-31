/**
 * The spec resolver (`shared/spec/resolve.ts`): where it finds references,
 * one source per artifact, keys qualified by their source, the adapters the
 * configuration enables, and the command line. Stub adapters stand in for
 * the repository layouts, which have no adapter yet; the conformance test
 * holds every real adapter to the read-safety rules.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import type { SpecReference } from "../spec/adapter.ts";
import { bodyAdapter } from "../spec/adapters/body.ts";
import { DEFAULT_BODY_SECTION, readSpecsConfig } from "../spec/config.ts";
import { resolveSpec, summary } from "../spec/resolve.ts";
import {
  issue,
  NO_USER_LAYER,
  only,
  put,
  scratchRepo,
  stub,
} from "./spec-helpers.ts";

const RESOLVE = join(import.meta.dir, "..", "spec", "resolve.ts");

describe("where references are found", () => {
  test("a file the body links twice is one source with both findings, read once", async () => {
    const { root } = scratchRepo("spec-resolve-");
    put(
      root,
      "notes/export.md",
      "FR-001 Exports CSV\nAC-1 Has a header row (FR-001)\n",
    );
    const reads: SpecReference[] = [];
    const result = await resolveSpec(
      issue(
        "## Spec\n\n- [the export](notes/export.md#scope)\n\n## Notes\n\nAs `./notes/export.md` says.\n",
      ),
      root,
      {
        registry: [stub("notes", "notes", reads), bodyAdapter],
        config: only("notes", "body"),
      },
    );
    expect(result.sources).toEqual([
      { adapter: "body", ref: "#body/Spec", evidence: ["section"] },
      { adapter: "notes", ref: "notes/export.md", evidence: ["body link"] },
    ]);
    expect(reads.map((r) => r.ref)).toEqual(["notes/export.md"]);
    expect(result.acceptance.map((c) => c.key)).toEqual([
      "notes/export.md#AC-1",
    ]);
    expect(result.acceptance[0]?.requirement).toBe("notes/export.md#FR-001");
  });

  test("outside the Spec section a path counts only when an adapter claims it", async () => {
    const { root } = scratchRepo("spec-resolve-");
    put(root, "src/app.ts", "export {};\n");
    const result = await resolveSpec(
      issue("Change `src/app.ts`; the plan is in `notes/missing.md`.\n"),
      root,
      { registry: [stub("notes", "notes")], config: only("notes") },
    );
    expect(result.sources).toEqual([]);
    expect(result.unresolved).toEqual(["notes/missing.md (not found)"]);
  });

  test("a folder the layout claims is a source whose reference ends in /", async () => {
    const { root } = scratchRepo("spec-resolve-");
    put(root, "notes/export/criteria.md", "AC-1 Has a header row\n");
    const result = await resolveSpec(issue("## Spec\n\nnotes/export\n"), root, {
      registry: [stub("notes", "notes")],
      config: only("notes"),
    });
    expect(result.sources).toEqual([
      { adapter: "notes", ref: "notes/export/", evidence: ["body link"] },
    ]);
    expect(result.acceptance[0]?.key).toBe("notes/export/#AC-1");
  });

  test.skipIf(
    skipsOnWindows(
      "file-system",
      "creating a symbolic link needs a privilege Windows withholds by default",
    ),
  )(
    "a link inside the root is its target's source, and a link to an unclaimed file is refused",
    async () => {
      const { root } = scratchRepo("spec-resolve-");
      put(root, "notes/export.md", "AC-1 Has a header row\n");
      put(root, "secrets.txt", "AC-9 not a spec\n");
      symlinkSync(
        join(root, "notes", "export.md"),
        join(root, "notes", "alias.md"),
      );
      symlinkSync(join(root, "secrets.txt"), join(root, "notes", "leak.md"));
      const result = await resolveSpec(
        issue(
          "## Spec\n\n- notes/alias.md\n- notes/export.md\n- notes/leak.md\n",
        ),
        root,
        { registry: [stub("notes", "notes")], config: only("notes") },
      );
      expect(result.sources.map((s) => s.ref)).toEqual(["notes/export.md"]);
      expect(result.unresolved).toEqual([
        "notes/leak.md (no adapter claims it)",
      ]);
    },
  );

  test("a source its adapter cannot read is unresolved, with the adapter's reason", async () => {
    const { root } = scratchRepo("spec-resolve-");
    put(root, "notes/broken.md", "anything\n");
    const result = await resolveSpec(
      issue("## Spec\n\n- notes/broken.md\n"),
      root,
      {
        registry: [stub("notes", "notes")],
        config: only("notes"),
      },
    );
    expect(result.sources).toEqual([]);
    expect(result.unresolved).toEqual([
      "notes/broken.md (notes could not read it: unparseable)",
    ]);
  });
});

describe("keys", () => {
  test("two sources that both number an AC-1 give two keys; a criterion links a requirement only by a unique id", async () => {
    const { root } = scratchRepo("spec-resolve-");
    put(
      root,
      "notes/a.md",
      "FR-001 Exports CSV\nAC-1 Has a header row (FR-001)\n",
    );
    put(root, "notes/b.md", "FR-002 Names its range\nFR-003 Streams\n");
    put(root, "notes/c.md", "FR-002 Also numbered two\n");
    const result = await resolveSpec(
      issue(
        "## Spec\n\n- notes/a.md\n- notes/b.md\n- notes/c.md\n- AC-1 Body criterion for FR-001\n- AC-2 Ambiguous: FR-002\n",
      ),
      root,
      {
        registry: [stub("notes", "notes"), bodyAdapter],
        config: only("notes", "body"),
      },
    );
    expect(result.acceptance.map((c) => [c.key, c.requirement])).toEqual([
      ["#body/Spec#AC-1", "notes/a.md#FR-001"],
      ["#body/Spec#AC-2", null],
      ["notes/a.md#AC-1", "notes/a.md#FR-001"],
    ]);
  });
});

describe("which adapters run", () => {
  test("specs.adapters restricts and orders them; the first that claims a path reads it", async () => {
    const { root } = scratchRepo("spec-resolve-");
    put(root, "notes/a.md", "AC-1 x\n");
    const registry = [
      stub("first", "notes"),
      stub("second", "notes"),
      bodyAdapter,
    ];
    const body = issue(
      "## Spec\n\n- notes/a.md\n\n## Acceptance criteria\n\n- y\n",
    );
    const reordered = await resolveSpec(body, root, {
      registry,
      config: only("second", "first"),
    });
    expect(reordered.sources).toEqual([
      { adapter: "second", ref: "notes/a.md", evidence: ["body link"] },
    ]);
    const byDefault = await resolveSpec(body, root, {
      registry,
      config: { adapters: null, bodySection: DEFAULT_BODY_SECTION },
    });
    expect(byDefault.sources.map((s) => `${s.adapter} ${s.ref}`)).toEqual([
      "body #body/Spec",
      "body #body/Acceptance criteria",
      "first notes/a.md",
    ]);
  });

  test("an adapter whose layout is absent claims nothing", async () => {
    const { root } = scratchRepo("spec-resolve-");
    put(root, "notes/a.md", "AC-1 x\n");
    const result = await resolveSpec(issue("## Spec\n\n- notes/a.md\n"), root, {
      registry: [stub("notes", "notes", [], false)],
      config: { adapters: null, bodySection: DEFAULT_BODY_SECTION },
    });
    expect(result.unresolved).toEqual(["notes/a.md (no adapter claims it)"]);
  });
});

describe("the specs configuration", () => {
  test("reads the repository's heading and refuses what it cannot use, naming the file", () => {
    const { root } = scratchRepo("spec-config-");
    expect(readSpecsConfig(root, ["body"], NO_USER_LAYER)).toEqual({
      adapters: null,
      bodySection: "Spec",
    });
    put(
      root,
      ".config/jig.yaml",
      "specs:\n  adapters: [body]\n  body_section: Plan\n",
    );
    expect(readSpecsConfig(root, ["body"], NO_USER_LAYER)).toEqual({
      adapters: ["body"],
      bodySection: "Plan",
    });
    for (const [yaml, message] of [
      [
        "specs:\n  adapters: [elsewhere]\n",
        "specs.adapters names an unknown adapter elsewhere (known: body)",
      ],
      [
        "specs:\n  adapters: []\n",
        "specs.adapters must be a list of distinct adapter names",
      ],
      [
        "specs:\n  body_section: '## Spec'\n",
        "specs.body_section must be a heading's text",
      ],
      [
        "specs:\n  body_section: 'Acceptance criteria:'\n",
        "specs.body_section must differ from the Acceptance criteria heading",
      ],
      [
        "specs:\n  body_section: requirements\n",
        "specs.body_section must differ from the Requirements heading",
      ],
      [
        "specs:\n  require_for_types: [feature]\n",
        "specs.require_for_types is not a field",
      ],
    ] as const) {
      put(root, ".config/jig.yaml", yaml);
      expect(() => readSpecsConfig(root, ["body"], NO_USER_LAYER)).toThrow(
        message,
      );
      expect(() => readSpecsConfig(root, ["body"], NO_USER_LAYER)).toThrow(
        ".config/jig.yaml",
      );
    }
  });

  test("a null field reads as not set", () => {
    const { root } = scratchRepo("spec-config-");
    put(
      root,
      ".config/jig.yaml",
      "specs:\n  adapters: null\n  body_section: null\n",
    );
    expect(readSpecsConfig(root, ["body"], NO_USER_LAYER)).toEqual({
      adapters: null,
      bodySection: "Spec",
    });
  });

  test("the user file may not set it: it describes one repository", () => {
    const { root, outside } = scratchRepo("spec-config-");
    put(outside, "jig.yaml", "specs:\n  body_section: Plan\n");
    expect(() =>
      readSpecsConfig(root, ["body"], { JIG_HOME: outside }),
    ).toThrow("specs.body_section describes one repository");
  });
});

describe("the command line", () => {
  /** Run the resolver from a folder inside `root`, which it must find itself. */
  function run(root: string, ...args: string[]) {
    const cwd = join(root, "docs");
    mkdirSync(cwd, { recursive: true });
    const child = Bun.spawnSync([process.execPath, RESOLVE, ...args], {
      cwd,
      env: {
        ...process.env,
        ...NO_USER_LAYER,
        JIG_OVERLAY: undefined,
        JIG_CONSUMER_ROOT: undefined,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      ...child,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
    };
  }

  test("prints the result as JSON, or a summary of it", () => {
    const { root } = scratchRepo("spec-cli-");
    const input = put(
      root,
      "issue.json",
      JSON.stringify(
        issue(
          "## Acceptance criteria\n\n- AC-1 Works\n\n## Spec\n\nhttps://example.com/x\n",
        ),
      ),
    );
    const json = run(root, "--input", input);
    expectSpawnExit(json, 0);
    const result: unknown = JSON.parse(json.stdout);
    expect(result).toMatchObject({
      acceptance: [{ key: "#body/Acceptance criteria#AC-1" }],
    });
    const text = run(root, "--input", input, "--summary");
    expectSpawnExit(text, 0);
    expect(text.stdout.trim()).toBe(
      [
        "Spec: 2 sources, 0 requirements, 1 acceptance criterion, 0 tasks",
        "Acceptance criteria:",
        "- #body/Acceptance criteria#AC-1: Works",
        "Sources:",
        "- #body/Acceptance criteria (body: section)",
        "- #body/Spec (body: section)",
        "Unresolved:",
        "- https://example.com/x (web link, not fetched)",
      ].join("\n"),
    );
  });

  test("refuses an issue that was not found, and a configuration it cannot use", () => {
    const { root } = scratchRepo("spec-cli-");
    const missing = put(root, "missing.json", JSON.stringify({ found: false }));
    const notFound = run(root, "--input", missing);
    expectSpawnExit(notFound, 2);
    expect(notFound.stderr).toContain("the input is not an issue");
    put(root, ".config/jig.yaml", "specs:\n  adapters: [elsewhere]\n");
    const input = put(root, "issue.json", JSON.stringify(issue("")));
    const badConfig = run(root, "--input", input);
    expectSpawnExit(badConfig, 1);
    expect(badConfig.stderr).toContain("unknown adapter elsewhere");
  });

  test("takes no root from its arguments: reads stay in the working directory's repository", () => {
    const { root, outside } = scratchRepo("spec-cli-");
    put(outside, "notes.md", "AC-1 outside\n");
    const input = put(
      root,
      "issue.json",
      JSON.stringify(issue("## Spec\n\n- ../outside/notes.md\n")),
    );
    const moved = run(root, "--root", outside, "--input", input);
    expectSpawnExit(moved, 2);
    expect(moved.stderr).toContain("--root");
    const result = run(root, "--input", input);
    expectSpawnExit(result, 0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      unresolved: ["../outside/notes.md (leaves the repository)"],
    });
  });
});

test("the summary of an empty result says so", () => {
  expect(
    summary({
      sources: [],
      requirements: [],
      acceptance: [],
      tasks: [],
      unresolved: [],
    }),
  ).toBe("Spec: 0 sources, 0 requirements, 0 acceptance criteria, 0 tasks");
});
