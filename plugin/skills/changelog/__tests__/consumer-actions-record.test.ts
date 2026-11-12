import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { spawnSync } from "../../../shared/guarded-git-spawn.ts";
import { checkNotes } from "../scripts/check.ts";
import { parseChangelogSection } from "../scripts/config.ts";
import {
  type ConsumerActionsRecord,
  deriveRecord,
  RECORD_SCHEMA,
  recordText,
} from "../scripts/consumer-actions-record.ts";
import { KEEP_A_CHANGELOG } from "../scripts/formats.ts";
import { lintResolved } from "../scripts/lint.ts";
import { release } from "../scripts/release.ts";
import {
  cleanEnv,
  COMMON_CHANGELOG,
  commit,
  git,
  jigYaml,
  KEEP_CHANGELOG,
  MANIFEST,
  repository,
  resolvedFor,
  temporary,
  write,
} from "./scratch.ts";

/** The id the design gives an action, computed here from its parts. */
const expectedId = (
  version: string,
  description: string,
  declaration: [string, string[], string, string[]],
): string =>
  `${version}#${new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([description, ...declaration]))
    .digest("hex")
    .slice(0, 8)}`;

const A =
  "- A. **Consumer action:** required at machine, instructions. Do it. **Detect:** `text:old phrase`.";
const A_ADVISED =
  "- A. **Consumer action:** advised at instructions, machine. Do it. **Detect:** `text:old phrase`.";
const B =
  "- B. **Consumer action:** advised at configuration. Set it. **Detect:** `config:!a.b`.";

const changelog = (entries130: string[]) => `# Changelog

## [Unreleased]

### Added

- Waiting. **Consumer action:** required at machine. Not released yet.

## [1.3.0] - 2026-02-01

### Added

${entries130.join("\n")}
- C. **Consumer action:** none.

### Fixed

- R. **Consumer action:** retracts 1.1.0#00000000.

## [1.2.0] - 2026-01-15

### Added

- Nothing a consumer does.

## [1.1.0] - 2026-01-02

### Changed

- Old. **Consumer action:** advised at machine. Upgrade.
`;

const derived = (text: string): ConsumerActionsRecord => {
  const record = deriveRecord(text, KEEP_A_CHANGELOG);
  if (!record.ok) throw new Error(record.failure.reason);
  return record.value;
};

describe("the derived record", () => {
  test("lists each released action with its id, oldest release first", () => {
    const record = derived(changelog([B, A, A, A_ADVISED]));
    expect(record.schema).toBe(RECORD_SCHEMA);
    expect(record.releases.map((r) => r.version)).toEqual(["1.1.0", "1.3.0"]);
    const [old, current] = record.releases;
    expect(old).toEqual({
      version: "1.1.0",
      actions: [
        {
          id: expectedId("1.1.0", "Old.", [
            "advised",
            ["machine"],
            "Upgrade.",
            [],
          ]),
          strength: "advised",
          levels: ["machine"],
          description: "Old.",
          instruction: "Upgrade.",
          hints: [],
        },
      ],
      retracts: [],
    });
    // Two identical entries are one action; the same description with
    // another declaration is another; `none` is not an action.
    expect(current?.actions.map((a) => a.id)).toEqual([
      expectedId("1.3.0", "B.", [
        "advised",
        ["configuration"],
        "Set it.",
        ["config:!a.b"],
      ]),
      expectedId("1.3.0", "A.", [
        "required",
        ["machine", "instructions"],
        "Do it.",
        ["text:old phrase"],
      ]),
      expectedId("1.3.0", "A.", [
        "advised",
        ["machine", "instructions"],
        "Do it.",
        ["text:old phrase"],
      ]),
    ]);
    expect(current?.actions[0]?.hints).toEqual([
      { kind: "config", value: "a.b", absent: true },
    ]);
    expect(current?.retracts).toEqual(["1.1.0#00000000"]);
  });

  test("an id does not depend on the entry's position", () => {
    const ids = (entries: string[]) =>
      derived(changelog(entries))
        .releases.flatMap((r) => r.actions.map((a) => a.id))
        .sort();
    expect(ids([A, B, A_ADVISED])).toEqual(ids([A_ADVISED, B, A]));
  });

  test("a release that declares nothing, and Unreleased, are not listed", () => {
    expect(derived(KEEP_CHANGELOG).releases).toEqual([]);
    expect(derived(changelog([])).releases.map((r) => r.version)).toEqual([
      "1.1.0",
      "1.3.0",
    ]);
  });

  test("its file is laid out as the JSON formatter lays it out", () => {
    const retractions = Array.from(
      { length: 6 },
      (_, i) => `- R${i}. **Consumer action:** retracts 1.1.${i}#0000000${i}.`,
    );
    const text = recordText(
      derived(changelog([A, B, A_ADVISED, ...retractions])),
    );
    // A short list of values fits a line, six ids do not.
    expect(text).toContain('"levels": ["machine", "instructions"]');
    expect(text).toContain('"retracts": [\n        "1.1.0#00000000",');
    const repositoryRoot = join(import.meta.dir, "..", "..", "..", "..");
    const formatted = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "node_modules/@biomejs/biome/bin/biome"),
        "format",
        "--stdin-file-path=record.json",
      ],
      { cwd: repositoryRoot, input: text, env: cleanEnv() },
    );
    expectSpawnExit(
      {
        exitCode: formatted.status,
        stdout: formatted.stdout,
        stderr: formatted.stderr,
      },
      0,
      "biome format",
    );
    expect(String(formatted.stdout)).toBe(text);
  });

  test("a malformed declaration in a released section is refused, naming its release", () => {
    const record = deriveRecord(
      changelog(["- D. **Consumer action:** required at nowhere. Do it."]),
      KEEP_A_CHANGELOG,
    );
    expect(record.ok).toBe(false);
    if (!record.ok)
      expect(record.failure.reason).toContain("1.3.0: unknown level `nowhere`");
  });
});

describe("the configuration", () => {
  const refused = (section: Record<string, unknown>) => {
    try {
      parseChangelogSection({ file: "CHANGELOG.md", ...section });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    return "";
  };

  test("both fields are validated", () => {
    expect(refused({ consumer_actions: "yes" })).toContain(
      "changelog.consumer_actions must be true or false",
    );
    expect(refused({ consumer_actions_record: "../x.json" })).toContain(
      "changelog.consumer_actions_record must stay inside",
    );
    expect(
      refused({ consumer_actions_record: ".github/workflows/x.json" }),
    ).toContain("is a workflow");
    expect(
      parseChangelogSection({
        file: "CHANGELOG.md",
        consumer_actions: true,
        consumer_actions_record: "./plugin/consumer-actions.json",
      }),
    ).toMatchObject({
      consumerActions: true,
      consumerActionsRecord: "plugin/consumer-actions.json",
    });
  });

  test("the record is no file the release writes otherwise, and only in a format that leaves entries as written", () => {
    const keep = repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      "p.json": MANIFEST("1.2.0"),
    });
    const version = {
      version: { files: [{ path: "p.json", key: "version" }] },
    };
    expect(() =>
      resolvedFor(keep, { ...version, consumer_actions_record: "p.json" }),
    ).toThrow("a file the release writes");
    const common = repository({
      "CHANGELOG.md": COMMON_CHANGELOG,
      "p.json": MANIFEST("1.2.0"),
    });
    expect(() =>
      resolvedFor(common, {
        ...version,
        format: "common-changelog",
        consumer_actions_record: "r.json",
      }),
    ).toThrow("appends a reference and authors");
  });
});

const SECTION =
  "  file: CHANGELOG.md\n  consumer_actions_record: plugin/actions.json\n  version:\n    files:\n      - { path: p.json, key: version }";

describe("the release step and the freshness check", () => {
  const script = join(
    import.meta.dir,
    "..",
    "scripts",
    "consumer-actions-record.ts",
  );
  const run = (cwd: string, ...args: string[]) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd,
      env: cleanEnv({ JIG_HOME: temporary("jig-home-") }),
    });
    return {
      exitCode: result.status,
      stdout: String(result.stdout),
      stderr: String(result.stderr),
    };
  };
  const configured = () =>
    repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      "p.json": MANIFEST("1.2.0"),
      ".config/jig.yaml": jigYaml(SECTION),
    });
  const options = (root: string) => ({
    ...resolvedFor(root, {
      version: { files: [{ path: "p.json", key: "version" }] },
      consumer_actions_record: "plugin/actions.json",
    }),
    date: "2026-03-01",
  });

  test("the release writes the record its changelog derives, under the version it releases", async () => {
    const root = configured();
    commit(
      root,
      {
        "changes/x.md": `---\nrelease: minor\n---\n\n### Added\n\n${A}\n`,
      },
      "note",
    );
    await release({ ...options(root), dryRun: true });
    expect(existsSync(join(root, "plugin/actions.json"))).toBe(false);
    await release(options(root));
    const record = JSON.parse(
      readFileSync(join(root, "plugin/actions.json"), "utf8"),
    ) as ConsumerActionsRecord;
    expect(record.releases.map((r) => r.version)).toEqual(["1.3.0"]);
    expect(record.releases[0]?.actions[0]?.id).toBe(
      expectedId("1.3.0", "A.", [
        "required",
        ["machine", "instructions"],
        "Do it.",
        ["text:old phrase"],
      ]),
    );
    expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toContain(
      "**Consumer action:** required at machine, instructions. Do it. **Detect:** `text:old phrase`.",
    );
    // The declaration stays inline emphasis and code spans: the format's own
    // rules find nothing in the release (the fixture's introduction never
    // mentions versioning, which is all they find).
    expect(lintResolved(options(root)).findings.map((f) => f.rule)).toEqual([
      "keep-a-changelog/semver-statement",
    ]);
    expectSpawnExit(run(root, "--check"), 0, "fresh after the release");
  });

  test("--check fails a record that is not what the changelog derives, and --write regenerates it", () => {
    const root = configured();
    expectSpawnExit(run(root, "--check"), 1, "missing record");
    expectSpawnExit(run(root, "--write"), 0, "write");
    expect(readFileSync(join(root, "plugin/actions.json"), "utf8")).toBe(
      recordText(derived(KEEP_CHANGELOG)),
    );
    expectSpawnExit(run(root, "--check"), 0, "fresh");
    write(root, "plugin/actions.json", '{"schema":1,"releases":[]}\n');
    const stale = run(root, "--check");
    expectSpawnExit(stale, 1, "edited by hand");
    expect(stale.stderr).toContain("--write");
    expectSpawnExit(run(root), 2, "neither mode");
  });

  test("a repository without the record is told so, exit 0", () => {
    const root = repository({
      "CHANGELOG.md": KEEP_CHANGELOG,
      "p.json": MANIFEST("1.2.0"),
      ".config/jig.yaml": jigYaml(
        "  file: CHANGELOG.md\n  version:\n    files:\n      - { path: p.json, key: version }",
      ),
    });
    const result = run(root, "--check");
    expectSpawnExit(result, 0, "not configured");
    expect(result.stdout).toContain("not configured");
  });

  test("a branch's retraction names a released action", () => {
    const root = configured();
    commit(
      root,
      {
        "CHANGELOG.md": changelog([B]),
      },
      "released",
    );
    git(root, "checkout", "-qb", "work");
    const known = expectedId("1.3.0", "B.", [
      "advised",
      ["configuration"],
      "Set it.",
      ["config:!a.b"],
    ]);
    const retracting = (id: string) =>
      `---\nrelease: patch\n---\n\n### Fixed\n\n- B was wrong. **Consumer action:** retracts ${id}.\n`;
    const findings = (id: string) => {
      write(root, "changes/x.md", retracting(id));
      return checkNotes({
        ...options(root),
        releasePaths: [],
        notePaths: [],
        authors: true,
        base: "main",
        record: "plugin/actions.json",
      }).findings;
    };
    expect(findings(known)).toEqual([]);
    expect(findings("1.3.0#ffffffff").join("\n")).toContain(
      "which no released consumer action has",
    );
  });
});
