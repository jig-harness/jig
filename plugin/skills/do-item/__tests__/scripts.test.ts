/**
 * scripts.test.ts — the do-item script surface.
 *
 * `determineAgents` is the one real decision procedure (catalog-primary,
 * label-fallback, title keywords, coordination arbitration), so it gets unit
 * coverage; the CLI wrappers get load probes and spawn tests against a fake
 * `linear` command-line client (the tracker's credential-less transport).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { load as loadYaml } from "../../../shared/yaml.ts";
import { parseCatalog } from "../../drive-pr/scripts/lib/change-areas-catalog.ts";
import {
  determineAgents as determine,
  parseAgentRouting,
} from "../scripts/determine_agent.ts";
import { parseArgs } from "../scripts/lib/cli.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

const SCRIPTS = join(import.meta.dir, "..", "scripts");
const OVERLAY = join(import.meta.dir, "fixtures", "overlay.yaml");
const ROUTING = parseAgentRouting(
  loadYaml(readFileSync(OVERLAY, "utf8")) as Record<string, unknown>,
);

// Catalogs are written as the YAML would parse, then read as the script does.
const determineAgents = (labels: string[], title: string, catalog: unknown) =>
  determine(
    labels,
    title,
    catalog === null ? null : parseCatalog(catalog),
    ROUTING,
  );

// Every spawn goes through this env: git hook variables scrubbed, the
// fixture overlay as the consumer configuration, and no Linear API key, so
// the tracker uses the `linear` client the test puts on PATH.
function gitCleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("GIT_") || v === undefined) continue;
    if (k === "LINEAR_API_KEY" || k === "LINEAR_API_TOKEN") continue;
    env[k] = v;
  }
  env.JIG_OVERLAY = OVERLAY;
  return env;
}

/**
 * A fake `linear` client answering `linear api <document> --variables-json
 * <json>`. Each case names the GraphQL operation and the exact variables it
 * expects; any other invocation exits 3, so a request-shape regression turns
 * the suite red instead of the stub answering regardless.
 */
function linearApiStub(
  cases: Array<{ operation: string; variables: string; payload: string }>,
): string {
  const branches = cases
    .map(
      (
        c,
        i,
      ) => `if [ "$1" = api ] && [ "$3" = --variables-json ] && [ '${c.variables}' = "$4" ]; then
  case "$2" in
    *"${c.operation}("*) cat <<'JSON_EOF_${i}'
${c.payload}
JSON_EOF_${i}
      exit 0 ;;
  esac
fi`,
    )
    .join("\n");
  return `#!/bin/sh
${branches}
echo "unexpected linear invocation: $*" >&2
exit 3
`;
}

const CATALOG = {
  areas: {
    backend: { agent: "backend" },
    web: { agent: "frontend" },
    docs: { agent: "docs" },
    migrations: {}, // an area with no agent field must fall through
  },
};

describe("determineAgents", () => {
  it("resolves the agent from the catalog when a codearea label maps to an area", () => {
    const r = determineAgents(["codearea:backend"], "", CATALOG);
    expect(r.primary_agent).toBe("Backend Agent");
    expect(r.catalog_source).toBe("Backend Agent");
    expect(r.coordination_needed).toBe(false);
    expect(r.scouts).toContain("Schema Scout");
  });

  it("does not double-count a catalog-resolved label through the fallback mapping", () => {
    const r = determineAgents(["codearea:backend"], "", CATALOG);
    expect(r.all_agents).toEqual(["Backend Agent"]);
  });

  it("keeps every catalog-backed code area, not just the first by area key", () => {
    // Returning one hit would drop Frontend Agent, and because the label was
    // still marked catalog-resolved, its fallback would be skipped too.
    const r = determineAgents(
      ["codearea:web", "codearea:backend"],
      "",
      CATALOG,
    );
    expect(r.all_agents).toEqual(["Backend Agent", "Frontend Agent"]);
    expect(r.catalog_source).toBe("Backend Agent");
    expect(r.primary_agent).toBe("Backend Agent");
    expect(r.coordination_needed).toBe(true);
  });

  it("falls back to the label mapping when the catalog is unavailable", () => {
    const r = determineAgents(["agent:frontend"], "", null);
    expect(r.primary_agent).toBe("Frontend Agent");
    expect("catalog_source" in r).toBe(false);
  });

  it("matches labels case-insensitively and reports the labels it matched", () => {
    const r = determineAgents(["Agent:DevOps", "size:m"], "", null);
    expect(r.all_agents).toEqual(["DevOps Agent"]);
    expect(r.labels_matched).toEqual(["Agent:DevOps"]);
    expect(r.scouts).toEqual([]);
  });

  it("falls back when the catalog area carries no agent field", () => {
    // codearea:database → area `migrations`, which has no `agent:`; the label
    // mapping must still answer.
    const r = determineAgents(["codearea:database"], "", CATALOG);
    expect(r.primary_agent).toBe("Backend Agent");
    expect("catalog_source" in r).toBe(false);
  });

  it("prefers the catalog-sourced agent on a two-agent tie", () => {
    const r = determineAgents(
      ["domain:platform", "codearea:backend"],
      "",
      CATALOG,
    );
    expect(r.all_agents).toHaveLength(2);
    expect(r.primary_agent).toBe("Backend Agent");
    expect(r.coordination_needed).toBe(true);
  });

  it("hands more than two agents to the integrator", () => {
    const r = determineAgents(
      ["agent:backend", "agent:frontend", "agent:devops"],
      "",
      null,
    );
    expect(r.primary_agent).toBe("Full-Stack Integrator Agent");
    expect(r.coordination_needed).toBe(true);
  });

  it("applies the configured title keywords", () => {
    const t = determineAgents([], "Fix flaky test", null);
    expect(t.all_agents).toEqual(["Tester Agent"]);
    expect(t.scouts).toEqual(["Test Pattern Finder"]);
  });

  it("uses the configured default when nothing matches", () => {
    const r = determineAgents(["size:m"], "Do the thing", null);
    expect(r.primary_agent).toBe("Backend Agent");
    expect(r.coordination_needed).toBe(false);
  });

  it("defaults to general-purpose with no routing configured", () => {
    const bare = parseAgentRouting({});
    const r = determine(["agent:backend"], "", null, bare);
    expect(r.primary_agent).toBe("general-purpose");
    expect(r.scouts).toEqual([]);
    expect(bare.integrator).toBe("general-purpose");
  });

  it("refuses a malformed routing section", () => {
    expect(() =>
      parseAgentRouting({ do_item: { agents: { labels: ["x"] } } }),
    ).toThrow("do_item.agents.labels");
    expect(() =>
      parseAgentRouting({ do_item: { scouts: { "Backend Agent": "x" } } }),
    ).toThrow("do_item.scouts");
  });

  it("refuses the pre-rename do_issue section instead of ignoring it", () => {
    expect(() =>
      parseAgentRouting({ do_issue: { agents: { default: "x" } } }),
    ).toThrow("now called do_item");
    expect(() => parseAgentRouting({ do_issue: null, do_item: {} })).toThrow(
      "now called do_item",
    );
  });

  // Every table is keyed by external input (a label, a catalog `agent`
  // value), so an inherited member must never answer a lookup.
  for (const proto of ["constructor", "toString", "valueOf", "__proto__"]) {
    it(`a '${proto}' catalog agent value yields no agent`, () => {
      const r = determineAgents(["codearea:docs"], "", {
        areas: { docs: { agent: proto } },
      });
      expect(r.all_agents).toEqual(["Documentation Agent"]);
      expect("catalog_source" in r).toBe(false);
    });

    it(`a '${proto}' label matches no mapping`, () => {
      const r = determineAgents([proto], "", null);
      expect(r.all_agents).toEqual(["Backend Agent"]);
      expect(r.labels_matched).toEqual([]);
    });

    it(`a '${proto}' catalog area key is not inherited`, () => {
      const r = determineAgents(["codearea:docs"], "", { areas: {} });
      expect(r.all_agents).toEqual(["Documentation Agent"]);
      expect("catalog_source" in r).toBe(false);
    });
  }

  it("keeps a configured '__proto__' label as an ordinary entry", () => {
    const routing = parseAgentRouting(
      JSON.parse(
        '{"do_item":{"agents":{"labels":{"__proto__":"Odd Agent"}}}}',
      ) as Record<string, unknown>,
    );
    expect(determine(["__proto__"], "", null, routing).all_agents).toEqual([
      "Odd Agent",
    ]);
  });

  it("every emitted agent is a string, never an inherited function", () => {
    const r = determineAgents(["codearea:docs", "constructor"], "", {
      areas: { docs: { agent: "constructor" } },
    });
    for (const a of r.all_agents as unknown[]) expect(typeof a).toBe("string");
    expect(typeof r.primary_agent).toBe("string");
  });
});

describe("the CLI wrappers", () => {
  // A `linear` stub that fails instantly: the probe asks whether the
  // module graph loads (incl. the js-yaml import resolving from the repo
  // root), not whether the CLIs answer.
  let stubBin: string;
  beforeAll(() => {
    stubBin = mkdtempSync(join(tmpdir(), "do-item-stub-"));
    writeFakeProgram(join(stubBin, "linear"), "#!/bin/sh\nexit 1\n");
  });
  afterAll(() => {
    rmSync(stubBin, { recursive: true, force: true });
  });

  // `status` and `shape` are the contract, with `linear` stubbed to exit 1:
  // a wrapper that prints `{}` or exits with the wrong code must redden this.
  for (const [rel, args, stdin, status, shape] of [
    ["get_issue.ts", ["ENG-0"], undefined, 2, { found: false }],
    [
      "determine_agent.ts",
      ["-"],
      '{"labels":[],"title":""}',
      0,
      { primary_agent: "Backend Agent", coordination_needed: false },
    ],
  ] as const) {
    it(`${rel} loads and prints its JSON answer`, () => {
      const r = spawnSync(process.execPath, [join(SCRIPTS, rel), ...args], {
        encoding: "utf8",
        input: stdin,
        env: {
          ...gitCleanEnv(),
          PATH: `${stubBin}${delimiter}${process.env.PATH}`,
        },
      });
      // Each wrapper prints a JSON document even when its CLI is absent.
      expect({ rel, status: r.status }).toEqual({ rel, status });
      expect(JSON.parse(r.stdout)).toMatchObject(shape);
    });
  }

  // Well-formed JSON of the wrong SHAPE is a usage error (exit 2), not the
  // generic unexpected-error exit 1 it produced when `JSON.parse` was asserted
  // straight to `{ labels?: string[]; title?: string }` — `"backend"` was then
  // iterated character by character and `42` threw inside `toLowerCase()`.
  for (const [what, stdin] of [
    ["a non-object document", "[]"],
    ["labels as a bare string", '{"labels":"backend"}'],
    ["a non-string label element", '{"labels":["a",7]}'],
    ["a non-string title", '{"title":42}'],
  ] as const) {
    it(`determine_agent.ts rejects ${what} as a usage error`, () => {
      const r = spawnSync(
        process.execPath,
        [join(SCRIPTS, "determine_agent.ts"), "-"],
        {
          encoding: "utf8",
          input: stdin,
          env: {
            ...gitCleanEnv(),
            PATH: `${stubBin}${delimiter}${process.env.PATH}`,
          },
        },
      );
      expect({ what, status: r.status }).toEqual({ what, status: 2 });
      expect(r.stderr).toContain("Invalid input:");
    });
  }

  // argparse rejected an unknown option and an extra positional with exit 2;
  // the hand-written ports did neither, two of them taking the FIRST non-flag
  // argument and dropping the rest while determine_agent.ts took the LAST
  // unrecognised token as its input path.
  // One `parseArgs` in scripts/lib/cli.ts now answers for all three, so these
  // cases cover the shared parser through each caller's own option set.
  for (const [what, rel, args, stdin, expected] of [
    [
      "an unknown option",
      "get_issue.ts",
      ["ENG-1", "--typo"],
      undefined,
      "unknown option: --typo",
    ],
    [
      "a second positional",
      "get_issue.ts",
      ["ENG-1", "ENG-2"],
      undefined,
      "expected exactly one argument, got 2",
    ],
    [
      "an unknown option",
      "determine_agent.ts",
      ["-", "--typo"],
      "{}",
      "unknown option: --typo",
    ],
    [
      "a missing positional",
      "get_issue.ts",
      ["--verbose"],
      undefined,
      "missing required argument",
    ],
    [
      "a value option with no value",
      "determine_agent.ts",
      ["-", "--catalog"],
      "{}",
      "--catalog requires a value",
    ],
    // An OPTION token following a value flag is a missing value, not the
    // value: consuming `--verbose` as the catalog path made loadCatalog() fail
    // silently and routed the issue to the default agent.
    [
      "an option token where a value belongs",
      "determine_agent.ts",
      ["-", "--catalog", "--verbose"],
      "{}",
      "--catalog requires a value",
    ],
    // argparse's rule: any `-`-prefixed token EXCEPT a bare `-` is an option.
    // Testing for `--` alone would leave single-dash tokens as ordinary
    // values, so `-v` would become the catalog path.
    [
      "a single-dash token where a value belongs",
      "determine_agent.ts",
      ["-", "--catalog", "-v"],
      "{}",
      "--catalog requires a value",
    ],
    [
      "an unknown single-dash option",
      "determine_agent.ts",
      ["-", "-v"],
      "{}",
      "unknown option: -v",
    ],
    [
      "an unknown single-dash option on a wrapper",
      "get_issue.ts",
      ["ENG-1", "-v"],
      undefined,
      "unknown option: -v",
    ],
    [
      "a missing positional",
      "list_comments.ts",
      [],
      undefined,
      "missing required argument",
    ],
    [
      "a second positional",
      "list_comments.ts",
      ["ENG-1", "ENG-2"],
      undefined,
      "expected exactly one argument, got 2",
    ],
    [
      "an unknown option",
      "list_comments.ts",
      ["ENG-1", "--typo"],
      undefined,
      "unknown option: --typo",
    ],
  ] as const) {
    it(`${rel} rejects ${what} as a usage error`, () => {
      const r = spawnSync(process.execPath, [join(SCRIPTS, rel), ...args], {
        encoding: "utf8",
        input: stdin,
        env: {
          ...gitCleanEnv(),
          PATH: `${stubBin}${delimiter}${process.env.PATH}`,
        },
      });
      expect({ rel, what, status: r.status }).toEqual({
        rel,
        what,
        status: 2,
      });
      expect(r.stderr).toContain(expected);
    });
  }
});

describe("parseArgs matches argparse on `--` and `--opt=value`", () => {
  // Unit tests over the parser itself, not through a spawn: `bun script.ts --
  // -x` STRIPS the terminator before argv reaches the script (measured), so a
  // CLI-level probe would be testing the runtime rather than the parser. The wrapper-level suites above cover the spawn path.
  const SPEC = {
    flags: ["verbose"],
    values: ["catalog"],
    defaultPositional: "-",
    usage: "usage: …",
  };
  const parse = (argv: string[]) => parseArgs(argv, SPEC);

  it("`--` terminates options, so a dash-leading positional is reachable", () => {
    const r = parse(["--", "-weird-name.json"]);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.args.positional).toBe("-weird-name.json");
  });

  it("`--` also protects a token that looks like a declared option", () => {
    const r = parse(["--", "--verbose"]);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) {
      expect(r.args.positional).toBe("--verbose");
      expect(r.args.flags.has("verbose")).toBe(false);
    }
  });

  it("`--opt=value` is accepted for a value option", () => {
    const r = parse(["-", "--catalog=/tmp/c.yaml"]);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.args.values.get("catalog")).toBe("/tmp/c.yaml");
  });

  it("`--opt=value` keeps an `=` inside the value", () => {
    const r = parse(["-", "--catalog=/tmp/a=b.yaml"]);
    expect(r).toMatchObject({ ok: true });
    if (r.ok) expect(r.args.values.get("catalog")).toBe("/tmp/a=b.yaml");
  });

  it("`--opt=` is an explicit empty value, not a value", () => {
    expect(parse(["-", "--catalog="])).toMatchObject({
      ok: false,
      message: expect.stringContaining("requires a value"),
    });
  });

  it("a flag rejects an inline value", () => {
    expect(parse(["-", "--verbose=1"])).toMatchObject({
      ok: false,
      message: expect.stringContaining("does not take a value"),
    });
  });

  it("`--` is not consumed as a value option's value", () => {
    expect(parse(["-", "--catalog", "--"])).toMatchObject({
      ok: false,
      message: expect.stringContaining("--catalog requires a value"),
    });
  });

  it("everything after `--` is positional, so a second one still refuses", () => {
    expect(parse(["--", "a", "b"])).toMatchObject({
      ok: false,
      message: expect.stringContaining("exactly one argument"),
    });
  });
});

describe("determine_agent.ts keeps its optional positional", () => {
  // `nargs="?", default="-"` in the Python predecessor: a bare invocation
  // reads stdin. Requiring a positional in the shared parser silently narrowed
  // that public contract, and an earlier test locked the narrowing in.
  for (const args of [[], ["--verbose"]] as const) {
    it(`\`${["determine_agent.ts", ...args].join(" ")}\` reads stdin`, () => {
      const r = spawnSync(
        process.execPath,
        [join(SCRIPTS, "determine_agent.ts"), ...args],
        {
          encoding: "utf8",
          input: '{"labels":["codearea:backend"],"title":""}',
          env: gitCleanEnv(),
        },
      );
      expect({ args, status: r.status }).toEqual({ args, status: 0 });
      expect(JSON.parse(r.stdout)).toMatchObject({
        primary_agent: "Backend Agent",
      });
    });
  }
});

describe("catalog agent resolution", () => {
  // A catalog `agent` value the routing does not know (a typo, or one added
  // to the catalog first) produces no agent, so it must not suppress the
  // label's own mapping. `codearea:docs` because its label mapping
  // (Documentation Agent) differs from the default (Backend Agent).
  const TYPO_CATALOG = { areas: { docs: { agent: "dcos" } } };

  it("an unmapped catalog agent value leaves the label mapping intact", () => {
    const r = determineAgents(["codearea:docs"], "", TYPO_CATALOG);
    expect(r.all_agents).toEqual(["Documentation Agent"]);
    expect("catalog_source" in r).toBe(false);
  });

  it("an unmapped value does not suppress a sibling area that does map", () => {
    const r = determineAgents(["codearea:backend", "codearea:web"], "", {
      areas: { backend: { agent: "bakcend" }, web: { agent: "frontend" } },
    });
    expect(r.all_agents).toEqual(["Frontend Agent", "Backend Agent"]);
    expect(r.catalog_source).toBe("Frontend Agent");
  });

  it("reads the catalog the overlay names", () => {
    const dir = mkdtempSync(join(tmpdir(), "do-item-catalog-"));
    try {
      writeFileSync(
        join(dir, "catalog.yaml"),
        "areas:\n  backend:\n    agent: devops\n",
      );
      writeFileSync(
        join(dir, "overlay.yaml"),
        `${readFileSync(OVERLAY, "utf8")}drive:\n  change_areas_catalog: ${join(dir, "catalog.yaml")}\n`,
      );
      const r = spawnSync(
        process.execPath,
        [join(SCRIPTS, "determine_agent.ts"), "-"],
        {
          encoding: "utf8",
          input: '{"labels":["codearea:backend"]}',
          env: {
            ...gitCleanEnv(),
            JIG_OVERLAY: join(dir, "overlay.yaml"),
          },
        },
      );
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({
        primary_agent: "DevOps Agent",
        catalog_source: "DevOps Agent",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes by labels and says why when the catalog has a malformed area", () => {
    const dir = mkdtempSync(join(tmpdir(), "do-item-catalog-"));
    try {
      writeFileSync(
        join(dir, "catalog.yaml"),
        "areas:\n  backend:\n    agent: devops\n    paths: src/**\n",
      );
      writeFileSync(
        join(dir, "overlay.yaml"),
        `${readFileSync(OVERLAY, "utf8")}drive:\n  change_areas_catalog: ${join(dir, "catalog.yaml")}\n`,
      );
      const r = spawnSync(
        process.execPath,
        [join(SCRIPTS, "determine_agent.ts"), "-"],
        {
          encoding: "utf8",
          input: '{"labels":["codearea:backend"]}',
          env: {
            ...gitCleanEnv(),
            JIG_OVERLAY: join(dir, "overlay.yaml"),
          },
        },
      );
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({
        primary_agent: "Backend Agent",
      });
      expect("catalog_source" in JSON.parse(r.stdout)).toBe(false);
      expect(r.stderr).toContain(
        "Catalog unavailable, routing by labels only:",
      );
      expect(r.stderr).toContain("catalog area backend.paths");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const ISSUE_OP = "query TrackerIssue";
const ISSUE_VARS = '{"id":"ENG-1"}';
const labels = (...names: string[]) =>
  JSON.stringify({
    pageInfo: { hasNextPage: false },
    nodes: names.map((name) => ({ name })),
  });
const issueJson = (over: Record<string, string> = {}) => {
  const fields: Record<string, string> = {
    id: '"uuid-1"',
    identifier: '"ENG-1"',
    title: '"t"',
    description: "null",
    url: '"https://tracker.example/ENG-1"',
    updatedAt: '"2026-09-28T11:12:15.915Z"',
    state: '{"name":"In Progress","type":"started"}',
    labels: labels(),
    parent: "null",
    children: '{"pageInfo":{"hasNextPage":false},"nodes":[]}',
    assignee: "null",
    project: "null",
    ...over,
  };
  const body = Object.entries(fields)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `"${k}":${v}`)
    .join(",");
  return `{"data":{"issue":{${body}}}}`;
};
const children = (...nodes: string[]) =>
  `{"pageInfo":{"hasNextPage":false},"nodes":[${nodes.join(",")}]}`;
const child = (id: string, state: string, childLabels?: string) =>
  `{"identifier":"${id}","title":"c","state":${state}${childLabels === undefined ? "" : `,"labels":${childLabels}`}}`;

describe("get_issue.ts reads the issue through the tracker", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const run = (payload: string, extra: string[] = []) => {
    const bin = mkdtempSync(join(tmpdir(), "do-item-linear-"));
    dirs.push(bin);
    writeFakeProgram(
      join(bin, "linear"),
      linearApiStub([{ operation: ISSUE_OP, variables: ISSUE_VARS, payload }]),
    );
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, "get_issue.ts"), "ENG-1", ...extra],
      {
        encoding: "utf8",
        env: {
          ...gitCleanEnv(),
          PATH: `${bin}${delimiter}${process.env.PATH}`,
        },
      },
    );
    return {
      status: r.status,
      stderr: r.stderr,
      json: JSON.parse(r.stdout) as Record<string, unknown>,
    };
  };

  // Each payload is otherwise valid, so the named defect is the sole reason
  // it is rejected.
  for (const [what, payload] of [
    ["a string `labels`", issueJson({ labels: '"backend"' })],
    ["a null child", issueJson({ children: children("null") })],
    ["a non-object `state`", issueJson({ state: "7" })],
    ["a non-string `title`", issueJson({ title: "42" })],
    ["a missing `identifier`", issueJson({ identifier: "" })],
    ["a missing `labels`", issueJson({ labels: "" })],
    ["a missing `children`", issueJson({ children: "" })],
    [
      "a label entry without a name",
      issueJson({ labels: '{"pageInfo":{"hasNextPage":false},"nodes":[{}]}' }),
    ],
    [
      "a child label entry without a name",
      issueJson({
        children: children(
          child(
            "ENG-2",
            '{"name":"Backlog","type":"backlog"}',
            '{"pageInfo":{"hasNextPage":false},"nodes":[{}]}',
          ),
        ),
      }),
    ],
    [
      "a children list with more pages",
      issueJson({ children: '{"pageInfo":{"hasNextPage":true},"nodes":[]}' }),
    ],
    [
      "a children list whose hasNextPage is not a boolean",
      issueJson({ children: '{"pageInfo":{"hasNextPage":"true"},"nodes":[]}' }),
    ],
    ["a non-object document", '{"data":{"issue":[]}}'],
    ["no issue", '{"data":{"issue":null}}'],
    [
      "an entity-not-found error",
      '{"errors":[{"message":"Entity not found: Issue"}],"data":null}',
    ],
  ] as const) {
    it(`${what} is reported as not found, not as exit 1`, () => {
      const r = run(payload);
      expect({ what, status: r.status, found: r.json.found }).toEqual({
        what,
        status: 2,
        found: false,
      });
    });
  }

  it("a well-formed response is read, labels flattened to names", () => {
    const r = run(
      issueJson({
        labels: labels("codearea:backend"),
        children: children(
          child("ENG-2", '{"name":"Done","type":"completed"}'),
        ),
      }),
    );
    expect({
      status: r.status,
      found: r.json.found,
      labels: r.json.labels,
      updatedAt: r.json.updatedAt,
      description: r.json.description,
    }).toEqual({
      status: 0,
      found: true,
      labels: ["codearea:backend"],
      updatedAt: "2026-09-28T11:12:15.915Z",
      description: "",
    });
  });

  it("an issue without labels or children is a real childless issue", () => {
    const r = run(issueJson());
    expect({
      status: r.status,
      found: r.json.found,
      labels: r.json.labels,
      analysis: r.json.sub_issue_analysis,
    }).toEqual({
      status: 0,
      found: true,
      labels: [],
      analysis: { total: 0, has_sub_issues: false },
    });
  });

  it("keeps a child's labels in the { name } shape reconcile_parent_status.ts reads", () => {
    const r = run(
      issueJson({
        children: children(
          child(
            "ENG-2",
            '{"name":"Backlog","type":"backlog"}',
            labels("manual-ops"),
          ),
        ),
      }),
    );
    const a = r.json.sub_issue_analysis as Record<string, unknown>;
    expect(
      (a.incomplete_issues as Array<{ labels: unknown }>)[0]?.labels,
    ).toEqual([{ name: "manual-ops" }]);
  });

  it("treats canceled and duplicate children as terminal, not as blocking work", () => {
    const r = run(
      issueJson({
        children: children(
          child("ENG-2", '{"name":"Done","type":""}'),
          child("ENG-3", '{"name":"Canceled","type":""}'),
          child("ENG-4", '{"name":"Duplicate","type":""}'),
        ),
      }),
    );
    const a = r.json.sub_issue_analysis as Record<string, unknown>;
    expect({
      total: a.total,
      completed: a.completed,
      abandoned: a.abandoned,
      incomplete: a.incomplete,
      // 3 children − 2 abandoned = 1 eligible, so one delivered reads 100%.
      progress_percent: a.progress_percent,
      all_complete: a.all_complete,
    }).toEqual({
      total: 3,
      completed: 1,
      abandoned: 2,
      incomplete: 0,
      progress_percent: 100,
      all_complete: true,
    });
  });

  it("matches a category-less state's whole name, never a substring", () => {
    const r = run(
      issueJson({
        children: children(
          child("ENG-2", '{"name":"Incomplete","type":""}'),
          child("ENG-3", '{"name":"Not done","type":""}'),
          child("ENG-4", '{"name":"Duplicate investigation","type":""}'),
          child("ENG-5", '{"name":"closed","type":""}'),
        ),
      }),
    );
    const a = r.json.sub_issue_analysis as Record<string, unknown>;
    expect([a.completed, a.abandoned, a.incomplete, a.all_complete]).toEqual([
      1,
      0,
      3,
      false,
    ]);
  });

  it("classifies by state category when the tracker gives one", () => {
    const r = run(
      issueJson({
        children: children(
          child("ENG-2", '{"name":"x","type":"completed"}'),
          child("ENG-3", '{"name":"x","type":"canceled"}'),
          child("ENG-4", '{"name":"x","type":"started"}'),
        ),
      }),
    );
    const a = r.json.sub_issue_analysis as Record<string, unknown>;
    expect([a.completed, a.abandoned, a.incomplete, a.all_complete]).toEqual([
      1,
      1,
      1,
      false,
    ]);
  });

  it("never lets a name pattern override a recognized, different category", () => {
    const r = run(
      issueJson({
        children: children(
          child(
            "ENG-2",
            '{"name":"Canceled Backlog Items","type":"completed"}',
          ),
          child("ENG-3", '{"name":"Done Duplicate Cleanup","type":"started"}'),
        ),
      }),
    );
    const a = r.json.sub_issue_analysis as Record<string, unknown>;
    expect([a.completed, a.abandoned, a.incomplete]).toEqual([1, 0, 1]);
  });

  it("emits the unreadable-state sentinel only when the tracker gave neither state field", () => {
    expect(
      run(issueJson({ state: '{"name":"Unknown","type":""}' })).json.state,
    ).toEqual({ name: "Unknown", type: "" });
    expect(
      run(issueJson({ state: '{"name":"","type":""}' })).json.state,
    ).toEqual({ name: "Unknown", type: "unknown" });
  });

  it("handles an all-abandoned child set without dividing by zero", () => {
    const r = run(
      issueJson({
        children: children(
          child("ENG-2", '{"name":"Canceled","type":"canceled"}'),
        ),
      }),
    );
    const a = r.json.sub_issue_analysis as Record<string, unknown>;
    expect([a.progress_percent, a.all_complete]).toEqual([100, true]);
  });

  it("--verbose prints the eligible denominator, excluding abandoned children", () => {
    const r = run(
      issueJson({
        children: children(
          child("ENG-2", '{"name":"Done","type":"completed"}'),
          child("ENG-3", '{"name":"Canceled","type":"canceled"}'),
          child("ENG-4", '{"name":"Duplicate","type":"duplicate"}'),
        ),
      }),
      ["--verbose"],
    );
    expect(r.stderr).toContain("Sub-issues: 1/1 complete");
  });

  it("fails with exit 1 when the repository configures no team", () => {
    const dir = mkdtempSync(join(tmpdir(), "do-item-noteam-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "overlay.yaml"),
      "issue_tracker:\n  adapter: linear\n",
    );
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, "get_issue.ts"), "ENG-1"],
      {
        encoding: "utf8",
        env: {
          ...gitCleanEnv(),
          JIG_OVERLAY: join(dir, "overlay.yaml"),
        },
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("issue_tracker.team");
  });
});

describe("list_comments.ts", () => {
  let stubBin: string;
  beforeAll(() => {
    stubBin = mkdtempSync(join(tmpdir(), "do-item-comments-stub-"));
    writeFakeProgram(join(stubBin, "linear"), "#!/bin/sh\nexit 1\n");
  });
  afterAll(() => {
    rmSync(stubBin, { recursive: true, force: true });
  });

  it("loads and reports a tracker failure", () => {
    const r = spawnSync(
      process.execPath,
      [join(SCRIPTS, "list_comments.ts"), "ENG-1"],
      {
        encoding: "utf8",
        env: {
          ...gitCleanEnv(),
          PATH: `${stubBin}${delimiter}${process.env.PATH}`,
        },
      },
    );
    expect(r.status).toBe(1);
  });

  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  const OP = "query TrackerComments";
  const comments = (nodes: string, pageInfo = '{"hasNextPage":false}') =>
    `{"data":{"issue":{"id":"uuid-1","comments":{"pageInfo":${pageInfo},"nodes":${nodes}}}}}`;

  const run = (
    payload: string,
    more: Array<{ variables: string; payload: string }> = [],
  ) => {
    const bin = mkdtempSync(join(tmpdir(), "do-item-comments-"));
    dirs.push(bin);
    writeFakeProgram(
      join(bin, "linear"),
      linearApiStub([
        { operation: OP, variables: '{"id":"ENG-1","after":null}', payload },
        ...more.map((m) => ({ operation: OP, ...m })),
      ]),
    );
    return spawnSync(
      process.execPath,
      [join(SCRIPTS, "list_comments.ts"), "ENG-1"],
      {
        encoding: "utf8",
        env: {
          ...gitCleanEnv(),
          PATH: `${bin}${delimiter}${process.env.PATH}`,
        },
      },
    );
  };

  for (const [what, payload] of [
    ["a non-object document", '{"data":[]}'],
    ["an issue with no comments connection", '{"data":{"issue":{"id":"u"}}}'],
    ["`nodes` as a bare string", comments('"x"')],
    ["a non-object element in `nodes`", comments("[7]")],
    ["a non-string `body`", comments('[{"id":"c","body":7}]')],
    [
      "a missing pageInfo",
      '{"data":{"issue":{"id":"u","comments":{"nodes":[]}}}}',
    ],
    [
      "a non-boolean hasNextPage",
      comments('[{"id":"c","body":"x"}]', '{"hasNextPage":"true"}'),
    ],
  ] as const) {
    it(`${what} is reported as unreadable, not as a crash`, () => {
      const r = run(payload);
      expect({ what, status: r.status, stdout: r.stdout }).toEqual({
        what,
        status: 1,
        stdout: "",
      });
    });
  }

  it("an empty comment list is a legitimate empty result", () => {
    const r = run(comments("[]"));
    expect({ status: r.status, comments: JSON.parse(r.stdout) }).toEqual({
      status: 0,
      comments: [],
    });
  });

  it("follows every page and returns the comments oldest first", () => {
    const r = run(
      comments(
        '[{"id":"c2","body":"second","createdAt":"2026-09-02T00:00:00.000Z"}]',
        '{"hasNextPage":true,"endCursor":"cur-1"}',
      ),
      [
        {
          variables: '{"id":"ENG-1","after":"cur-1"}',
          payload: comments(
            '[{"id":"c1","body":"## Scout Findings (abc1234)","createdAt":"2026-09-01T00:00:00.000Z","user":{"id":"u","guest":false}}]',
          ),
        },
      ],
    );
    expect({ status: r.status, comments: JSON.parse(r.stdout) }).toEqual({
      status: 0,
      comments: [
        {
          body: "## Scout Findings (abc1234)",
          createdAt: "2026-09-01T00:00:00.000Z",
        },
        { body: "second", createdAt: "2026-09-02T00:00:00.000Z" },
      ],
    });
  });

  it("refuses a repeated page cursor rather than looping", () => {
    const r = run(
      comments(
        '[{"id":"c1","body":"x"}]',
        '{"hasNextPage":true,"endCursor":"cur-1"}',
      ),
      [
        {
          variables: '{"id":"ENG-1","after":"cur-1"}',
          payload: comments(
            '[{"id":"c2","body":"y"}]',
            '{"hasNextPage":true,"endCursor":"cur-1"}',
          ),
        },
      ],
    );
    expect({ status: r.status, stdout: r.stdout }).toEqual({
      status: 1,
      stdout: "",
    });
  });

  it("its output feeds directly into select_scout_finding.ts", () => {
    const listRun = run(
      comments(
        '[{"id":"c1","body":"## Scout Findings (abc1234)","createdAt":"2026-09-01T00:00:00.000Z"}]',
      ),
    );
    expect(listRun.status).toBe(0);
    const select = spawnSync(
      process.execPath,
      [join(SCRIPTS, "select_scout_finding.ts"), "--current-hash", "abc1234"],
      { encoding: "utf8", input: listRun.stdout, env: gitCleanEnv() },
    );
    expect(select.status).toBe(0);
    expect(JSON.parse(select.stdout)).toMatchObject({ action: "reuse" });
  });
});

describe("tracker.ts", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  const run = (
    args: string[],
    cases: Array<{ operation: string; variables: string; payload: string }>,
    input?: string,
  ) => {
    const bin = mkdtempSync(join(tmpdir(), "do-item-tracker-"));
    dirs.push(bin);
    writeFakeProgram(join(bin, "linear"), linearApiStub(cases));
    return spawnSync(process.execPath, [join(SCRIPTS, "tracker.ts"), ...args], {
      encoding: "utf8",
      input,
      env: { ...gitCleanEnv(), PATH: `${bin}${delimiter}${process.env.PATH}` },
    });
  };

  it("prints the configured state names", () => {
    const r = run(["states"], []);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      in_review: "Code Review",
      in_progress: "In Progress",
    });
  });

  it("prints the label vocabulary, defaults filled in", () => {
    const r = run(["labels"], []);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({
      epic: "epic",
      hitl: "hitl",
      manual_ops: "manual-ops",
      extractable_tails: [
        "hitl:legal",
        "hitl:tactical",
        "manual-ops",
        "pr-followup",
      ],
    });
    expect(run(["labels", "extra"], []).status).toBe(2);
  });

  it("refuses the pre-rename do_issue section when printing states or labels", () => {
    const dir = mkdtempSync(join(tmpdir(), "do-item-tracker-"));
    dirs.push(dir);
    const overlay = join(dir, "overlay.yaml");
    writeFileSync(
      overlay,
      "issue_tracker:\n  team: ENG\ndo_issue:\n  gates: []\n",
    );
    for (const op of ["states", "labels"]) {
      const r = spawnSync(process.execPath, [join(SCRIPTS, "tracker.ts"), op], {
        encoding: "utf8",
        env: { ...gitCleanEnv(), JIG_OVERLAY: overlay },
      });
      expect({ op, status: r.status, stdout: r.stdout }).toEqual({
        op,
        status: 1,
        stdout: "",
      });
      expect(r.stderr).toContain("now called do_item");
    }
  });

  it("moves an issue to the tracker's name for a canonical state", () => {
    const r = run(
      ["transition", "ENG-1", "in_review"],
      [
        {
          operation: "query TrackerIssueId",
          variables: '{"id":"ENG-1"}',
          payload:
            '{"data":{"issue":{"id":"uuid-1","team":{"id":"team-1","key":"ENG"}}}}',
        },
        {
          operation: "query TrackerStates",
          variables: '{"teamId":"team-1"}',
          payload:
            '{"data":{"team":{"states":{"pageInfo":{"hasNextPage":false},"nodes":[{"id":"s-9","name":"Code Review","type":"started"}]}}}}',
        },
        {
          operation: "mutation TrackerUpdate",
          variables: '{"id":"uuid-1","input":{"stateId":"s-9"}}',
          payload: '{"data":{"issueUpdate":{"success":true}}}',
        },
      ],
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      issue: "ENG-1",
      state: "in_review",
      name: "Code Review",
    });
  });

  it("posts a comment body from stdin", () => {
    const r = run(
      ["comment", "ENG-1"],
      [
        {
          operation: "query TrackerIssueId",
          variables: '{"id":"ENG-1"}',
          payload: '{"data":{"issue":{"id":"uuid-1","team":{"id":"team-1"}}}}',
        },
        {
          operation: "mutation TrackerComment",
          variables: '{"issueId":"uuid-1","body":"hello\\n"}',
          payload: '{"data":{"commentCreate":{"success":true}}}',
        },
      ],
      "hello\n",
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  for (const [what, args, expected] of [
    ["an unknown operation", ["close", "ENG-1"], "unknown operation"],
    [
      "a non-canonical state",
      ["transition", "ENG-1", "shipped"],
      "not a canonical state",
    ],
    ["a missing key", ["children"], "one issue key"],
  ] as const) {
    it(`rejects ${what} as a usage error`, () => {
      const r = run([...args], []);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(expected);
    });
  }
});

// select_scout_finding.ts's main() (its CLI entrypoint, as opposed to the
// selectScoutFinding() decision function covered directly in
// select_scout_finding.test.ts) was never actually exercised via spawn in
// this repo: its OWN documented usage (`--current-hash <hash>`, no bare
// argument) failed `parseArgs`'s usage check on every call, because the
// shared parser requires a positional unless `defaultPositional` is set and
// this script declared none — caught only by the end-to-end fallback test
// above, which is what first invoked main() with the documented argv shape.
describe("select_scout_finding.ts (CLI entrypoint)", () => {
  const run = (args: string[], stdin: string) =>
    spawnSync(
      process.execPath,
      [join(SCRIPTS, "select_scout_finding.ts"), ...args],
      { encoding: "utf8", input: stdin, env: gitCleanEnv() },
    );

  it("accepts its documented invocation with no positional argument", () => {
    const r = run(
      ["--current-hash", "abc1234"],
      '[{"body":"## Scout Findings (abc1234)","createdAt":"2026-09-01T00:00:00.000Z"}]',
    );
    expect({ status: r.status, stderr: r.stderr }).toEqual({
      status: 0,
      stderr: "",
    });
    expect(JSON.parse(r.stdout)).toMatchObject({ action: "reuse" });
  });

  it("rejects a single stray positional (the exact hole the empty-string defaultPositional hack left open)", () => {
    const r = run(["--current-hash", "abc1234", "extra"], "[]");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("expected no positional argument, got 1");
  });

  it("also rejects multiple stray positionals", () => {
    const r = run(["--current-hash", "abc1234", "extra", "stray"], "[]");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("expected no positional argument, got 2");
  });

  for (const [what, stdin] of [
    ["a null element", "[null]"],
    ["a non-string body", '[{"body":7}]'],
    ["a non-string created_at", '[{"body":"x","created_at":123}]'],
  ] as const) {
    it(`rejects ${what} as unreadable input, not a crash`, () => {
      const r = run(["--current-hash", "abc1234"], stdin);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("is not a valid comment");
    });
  }
});
