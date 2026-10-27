/**
 * The conformance test every spec adapter passes (`shared/spec/adapters/`).
 *
 * For each adapter in the registry: it declares a name, relative path
 * patterns and a layout check; every case in its fixture folder
 * (`fixtures/spec/<adapter>/<case>/`: `issue.json`, `expected.json`, and an
 * optional `repo/` tree the case's repository starts from) resolves, with
 * that adapter alone enabled, to exactly the expected result, which holds the
 * result's own invariants; and a reference the resolver must refuse (a web
 * link, an absolute path, a `..` escape, a symbolic link out of the root, an
 * ignored file such as `.env`, an unclaimed file) lands in `unresolved` with
 * its reason before the adapter reads anything.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { skipsOnWindows } from "../../../lib/test-helpers/windows-skip.ts";
import type { SpecAdapter, SpecReference } from "../spec/adapter.ts";
import { readSpecsConfig } from "../spec/config.ts";
import { ADAPTERS } from "../spec/registry.ts";
import { resolveSpec, type SpecResult } from "../spec/resolve.ts";
import { NO_USER_LAYER, only, put, scratchRepo } from "./spec-helpers.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "spec");
const SECRET = "AC-999 a criterion from outside the repository";

function parsed(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${path} is not a JSON object`);
  return value as Record<string, unknown>;
}

/** The result's own rules, whatever the adapter. */
function expectWellFormed(result: SpecResult): void {
  const refs = result.sources.map((s) => s.ref);
  expect(new Set(refs).size).toBe(refs.length);
  const entries = [
    ...result.requirements,
    ...result.acceptance,
    ...result.tasks,
  ];
  const keys = entries.map((e) => e.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const e of entries) {
    expect(e.key).toBe(`${result.sources[e.source]?.ref}#${e.id}`);
    expect(e.text.trim()).not.toBe("");
    expect(e.text).not.toContain("\n");
  }
  const requirementKeys = new Set(result.requirements.map((r) => r.key));
  for (const c of result.acceptance)
    if (c.requirement !== null)
      expect(requirementKeys.has(c.requirement)).toBe(true);
  for (const t of result.tasks) expect(typeof t.done).toBe("boolean");
}

/** A concrete path an adapter's first pattern matches; any path for one with none. */
function samplePath(adapter: SpecAdapter): string {
  const pattern = adapter.patterns[0];
  if (pattern === undefined) return "spec/sample.md";
  return pattern
    .replace(/\/$/, "")
    .replace(/\*\*\//g, "")
    .replace(/\*\*/g, "sample")
    .replace(/\*/g, "sample")
    .replace(/[{}[\]?]/g, "");
}

/** The adapter, recording every reference it is asked to read. */
function spy(adapter: SpecAdapter, reads: SpecReference[]): SpecAdapter {
  return {
    name: adapter.name,
    patterns: adapter.patterns,
    detect: (root) => adapter.detect(root),
    read: (ref) => {
      reads.push(ref);
      return adapter.read(ref);
    },
  };
}

let hits = 0;
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch() {
    hits++;
    return new Response(`- ${SECRET}\n`);
  },
});
afterAll(() => server.stop(true));

for (const adapter of ADAPTERS)
  describe(`the ${adapter.name} adapter`, () => {
    test("declares its name, relative patterns and a layout check", async () => {
      expect(adapter.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(ADAPTERS.filter((a) => a.name === adapter.name)).toHaveLength(1);
      for (const pattern of adapter.patterns) {
        expect(isAbsolute(pattern)).toBe(false);
        expect(pattern.split("/")).not.toContain("..");
      }
      const { root } = scratchRepo("spec-detect-");
      expect(typeof (await adapter.detect(root))).toBe("boolean");
    });

    const folder = join(FIXTURES, adapter.name);
    test("has a fixture folder with at least one case", () => {
      expect(existsSync(folder)).toBe(true);
      expect(readdirSync(folder).length).toBeGreaterThan(0);
    });

    for (const name of existsSync(folder) ? readdirSync(folder) : [])
      test(`resolves the ${name} fixture as expected`, async () => {
        const { root } = scratchRepo(`spec-${adapter.name}-`);
        const repo = join(folder, name, "repo");
        if (existsSync(repo)) cpSync(repo, root, { recursive: true });
        const config = {
          ...readSpecsConfig(root, [adapter.name], NO_USER_LAYER),
          adapters: [adapter.name],
        };
        const issue = parsed(join(folder, name, "issue.json"));
        const result = await resolveSpec(issue, root, {
          registry: [adapter],
          config,
        });
        expect(result).toEqual(
          parsed(join(folder, name, "expected.json")) as unknown as SpecResult,
        );
        expectWellFormed(result);
      });

    describe("refuses before any read", () => {
      const sample = samplePath(adapter);

      async function refusal(
        reference: string,
        setUp?: (s: ReturnType<typeof scratchRepo>) => void,
      ) {
        const scratch = scratchRepo(`spec-refuse-${adapter.name}-`);
        put(scratch.outside, sample, `- ${SECRET}\n`);
        setUp?.(scratch);
        const reads: SpecReference[] = [];
        const ref = reference
          .replaceAll("<outside>", scratch.outside)
          .replaceAll("<outside-name>", basename(scratch.outside));
        const result = await resolveSpec(
          { found: true, description: `## Spec\n\n- ${ref}\n` },
          scratch.root,
          { registry: [spy(adapter, reads)], config: only(adapter.name) },
        );
        expect(reads.filter((r) => r.kind === "file")).toEqual([]);
        expect(JSON.stringify(result)).not.toContain("AC-999");
        return { ref, result };
      }

      test("a web link, which is never fetched", async () => {
        const before = hits;
        const { ref, result } = await refusal(`${server.url}spec.md`);
        expect(result.unresolved).toEqual([`${ref} (web link, not fetched)`]);
        expect(hits).toBe(before);
      });

      test("an absolute path", async () => {
        const { ref, result } = await refusal(`<outside>/${sample}`);
        expect(result.unresolved).toEqual([`${ref} (absolute path)`]);
      });

      test("a path whose .. leaves the root", async () => {
        const { ref, result } = await refusal(`../<outside-name>/${sample}`);
        expect(result.unresolved).toEqual([`${ref} (leaves the repository)`]);
      });

      test.skipIf(
        skipsOnWindows(
          "file-system",
          "creating a symbolic link needs a privilege Windows withholds by default",
        ),
      )("a symbolic link whose target is outside the root", async () => {
        const { ref, result } = await refusal(sample, ({ root, outside }) => {
          mkdirSync(dirname(join(root, sample)), { recursive: true });
          symlinkSync(join(outside, sample), join(root, sample));
        });
        expect(result.unresolved).toEqual([
          `${ref} (symbolic link out of the repository)`,
        ]);
      });

      test("a file Git ignores, such as .env", async () => {
        const { result } = await refusal(".env", ({ root }) => {
          put(root, ".gitignore", ".env\n");
          put(root, ".env", `${SECRET}\n`);
        });
        expect(result.unresolved).toEqual([".env (ignored by Git)"]);
      });

      test("an ignored file in the adapter's own layout", async () => {
        const { ref, result } = await refusal(sample, ({ root }) => {
          put(root, ".gitignore", `${sample}\n`);
          put(root, sample, `- ${SECRET}\n`);
        });
        expect(result.unresolved).toEqual([`${ref} (ignored by Git)`]);
      });

      test("a file no enabled adapter's patterns claim", async () => {
        const { result } = await refusal("unclaimed/notes.txt", ({ root }) => {
          put(root, "unclaimed/notes.txt", `${SECRET}\n`);
        });
        expect(result.unresolved).toEqual([
          "unclaimed/notes.txt (no adapter claims it)",
        ]);
      });
    });
  });
