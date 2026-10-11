/**
 * drive-pr suite: process plumbing: entry points, the gh deadline wrapper, run(), cancellation and timeouts.
 * Shared fixtures and probes live in drive-pr-harness.ts.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "../scripts/lib/cli";
import {
  hasLiveGroupMemberLinux,
  parsePsStatRows,
  type RunHandle,
  run,
} from "../scripts/lib/proc";
import { threadFrom } from "../scripts/lib/sample.ts";
import { MAX_STATUS_PUBLISHERS } from "../scripts/lib/status/evidence.ts";
import { TRUSTED_ASSOCIATIONS } from "../scripts/summary-findings";

import {
  SCRIPTS,
  tmpRoot,
  gitCleanEnv,
  useDrivePrSuite,
} from "./drive-pr-harness.ts";

useDrivePrSuite();

// ── Every outbound `gh` call is bounded ─────────────────────────────────────
//
// `references/terminal-states.md` § 13 states this as a universal claim, and a
// universal claim maintained by hand drifts the moment a new call site is added
// — which is exactly what happened: the migration wrapped most of
// `announce-merge-ready`'s calls and left `read_liveness`, the
// stale-announcement DELETE and `withdraw_posted` on raw `gh`, while the doc
// went on saying every call was wrapped (docomply-review +
// chatgpt-codex-connector, a reference-implementation pull request round 17). Reviewers found the three
// sites; nothing in the repo would have.
//
// So the claim is mechanized rather than restated. An unbounded call is mode 13
// in that reference: `--timeout` bounds the poll loop and never any one call, so
// a connection that is accepted and never completes parks an unattended driver
// past every advertised deadline.
//
// In the TypeScript port the chokepoint is `lib/proc.ts`: `ghCall()` is the one
// sanctioned way to spawn `gh`, and it carries the GH_CALL_TIMEOUT deadline on
// every call. The sweep therefore asserts that no OTHER file under scripts/
// spawns the binary directly — an argv literal starting with 'gh', under any
// of the spawn spellings the runtimes offer. `summary-findings.ts` predates
// the shared lib was allowlisted for its own `GH_TIMEOUT_MS` + kill timer; it
// now routes through the chokepoint like everything else and the exemption is
// gone, so the sweep enforces the whole directory. Anything reaching for `gh`
// without the wrapper is the regression this sweep exists to catch.
//
// It sweeps resolve-review-comments' TypeScript scripts too, because the drive
// loop SPAWNS them (SKILL.md §§ 2 and 6): an unbounded call there parks an
// unattended driver exactly as one here would, and both shipped that way —
// `resolve-thread.ts` and `list-unresolved-threads.ts` each spawned `gh` through
// a bare `spawnSync` while this sweep, scoped to drive-pr's own directory,
// stayed green (docomply-review, a reference-implementation pull request round 1). That skill carries its own
// chokepoint rather than importing this one (drive-pr already depends on it;
// importing back would make the two mutually dependent), so the sweep is
// parameterised by root, each with its own sanctioned files.
// SKILL.md § Runtime advertises `node <name>.ts` alongside `bun`. That claim was
// false: `summary-findings.ts` reached for `Bun.argv`, `Bun.spawn` and
// `Bun.spawnSync`, and drive-status.ts calls it on EVERY evaluation — so a
// Node-started drive died on `Bun is not defined` before it could report
// anything (chatgpt-codex-connector, a reference-implementation pull request round 2). `import.meta.main` was
// the subtler half: a Bun global that Node did not gain until v24.2, so below
// that it reads `undefined`, main() never runs, and the script exits 0 having
// printed nothing — which every caller reads as "no findings" rather than as a
// failure.
//
// Asserted against the runtime running these tests as well as against `node`,
// so the claim is checked in both directions rather than assumed for one.
describe("the documented `node` entry point actually runs (#4034 round 2)", () => {
  const nodeBin = process.execPath.includes("/bun") ? "node" : process.execPath;

  // A pure, offline mode: it prints the trusted-association vocabulary and
  // exits. Enough to prove the module loaded, argv parsed, and main() ran under
  // a runtime with no Bun globals at all — without a network call.
  const OFFLINE_ARGS = ["--trusted-associations"];

  it("summary-findings.ts produces the same answer under node and bun", () => {
    const script = join(SCRIPTS, "summary-findings.ts");
    const underBun = execFileSync(process.execPath, [script, ...OFFLINE_ARGS], {
      encoding: "utf8",
    });
    const underNode = execFileSync(nodeBin, [script, ...OFFLINE_ARGS], {
      encoding: "utf8",
      // The MODULE_TYPELESS_PACKAGE_JSON notice goes to stderr; only stdout is
      // the answer.
      stdio: ["ignore", "pipe", "ignore"],
    });
    expect(underNode).toBe(underBun);
    expect(underNode.trim().length).toBeGreaterThan(0);
  });

  it("every entry script LOADS under node, not just the one that regressed", () => {
    // The Bun-global sweep below is a proxy; this is the property itself.
    // Round 4 showed the two come apart: `verification-fit.ts` used no Bun
    // global at all and was still Node-unloadable, first through an
    // extensionless import and then through a `public readonly` parameter
    // property in a module it imports — the one piece of TypeScript sugar
    // Node's strip-only mode refuses (chatgpt-codex-connector, a reference-implementation pull request round
    // 4). Neither would ever have shown up in a source-text sweep.
    //
    // `--help` is not a supported flag on most of these; the point is only
    // whether the module GRAPH loads, so a usage error is a pass and a
    // module-resolution or syntax error is not.
    const entries = [...new Bun.Glob("*.ts").scanSync(SCRIPTS)].sort();
    expect(entries.length).toBeGreaterThan(5);
    const unloadable = entries.filter((rel) => {
      const r = spawnSync(nodeBin, [join(SCRIPTS, rel), "--help"], {
        encoding: "utf8",
      });
      return /ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_UNKNOWN_FILE_EXTENSION|Bun is not defined/.test(
        r.stderr ?? "",
      );
    });
    expect(unloadable).toEqual([]);
  });

  it("no drive-pr script reaches for a Bun global", () => {
    // The regression that produced the finding was one file's `Bun.*`, but the
    // claim is about the whole entry surface, so the sweep is too. `import.meta
    // .main` rides along: same class — a Bun-first API that degrades to silence
    // rather than to an error on Node.
    const offenders = [...new Bun.Glob("**/*.ts").scanSync(SCRIPTS)]
      .sort()
      .flatMap((rel) =>
        readFileSync(join(SCRIPTS, rel), "utf8")
          .split("\n")
          .map((line, i) => [i + 1, line] as const)
          .filter(([, line]) => !/^\s*(?:\/\/|\*)/.test(line))
          .filter(([, line]) =>
            /\bBun\.|\bimport\.meta\.(main|dir)\b/.test(line),
          )
          .map(([n, line]) => `${rel}:${n}: ${line.trim()}`),
      );
    expect(offenders).toEqual([]);
  });
});

describe("TRUSTED_ASSOCIATIONS has exactly one definition", () => {
  // `announce-merge-ready.ts` and `reconcile-replied-threads.ts` used to each
  // spawn `summary-findings.ts --trusted-associations` to read this vocabulary
  // back over a pipe — a 72KB module load to read a constant that was already
  // exported from the same file. Both now `import` it directly. The claim
  // worth pinning is not just "gating works" (the per-caller trust-gate tests
  // below already exercise OWNER/MEMBER vs. an untrusted association, via a
  // real spawn of each script — not a text scan): it is that there is
  // nowhere left for a second, drifting copy to hide.
  //
  // Text-matching source is inherently one counterexample behind a hand-rolled
  // rewrite (round 2: a comment retaining the old call shape while the real
  // code moved to a hardcoded set would satisfy a naive `toMatch`). Every
  // check below therefore runs against LIVE code with `//` line comments
  // stripped first — closing exactly that counterexample.
  //
  // Round 3 went further: a consumer that builds its OWN Set with TODAY's
  // members (`new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])`) passes every
  // text check here, because the decoy agrees with the export right now — it
  // only reveals itself once the two diverge. No text scan, comment-stripped
  // or not, can rule that out; per `.claude/rules/document-scanning-gates.md`
  // § 3 ("Parse or pin"), the answer is a real runtime dependency: "genuinely
  // depends on the LIVE TRUSTED_ASSOCIATIONS object" in each consumer's own
  // describe block (announce-merge-ready.ts here in this file,
  // reconcile-replied-threads.ts in its own test file) mutates the actually-
  // exported object before the script loads and asserts the observable
  // behaviour changes — something a structurally separate copy, however
  // faithfully it starts out matching, cannot do. Both are mutation-tested
  // against the exact decoy this round described, confirmed to fail on it.
  //
  // What remains out of scope, deliberately: a deliberately adversarial
  // rewrite that fabricates matching text around different live logic (e.g. a
  // string-built CLI flag for the retired `--trusted-associations` spawn) —
  // no test in this codebase defends against hostile obfuscation of its own
  // source, only against accidental drift.
  const CONSUMERS = [
    "announce-merge-ready.ts",
    "reconcile-replied-threads.ts",
    "lib/sample.ts",
  ];
  const USAGE: Record<string, RegExp> = {
    "announce-merge-ready.ts":
      /\bannouncements\(\s*pr\s*,\s*TRUSTED_ASSOCIATIONS\s*\)/,
    "reconcile-replied-threads.ts": /\bTRUSTED_ASSOCIATIONS\.has\(/,
    "lib/sample.ts": /\bTRUSTED_ASSOCIATIONS\.has\(/,
  };

  /** Drops everything from `//` to end-of-line, so a comment reproducing a
   * call shape can no longer stand in for the live code it once matched. */
  function stripLineComments(src: string): string {
    return src
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//");
        return idx === -1 ? line : line.slice(0, idx);
      })
      .join("\n");
  }

  it("summary-findings.ts still exports OWNER/MEMBER/COLLABORATOR", () => {
    expect([...TRUSTED_ASSOCIATIONS].sort()).toEqual([
      "COLLABORATOR",
      "MEMBER",
      "OWNER",
    ]);
  });

  it.each(CONSUMERS)(
    "%s imports TRUSTED_ASSOCIATIONS and passes it to its own trust check",
    (rel) => {
      const live = stripLineComments(readFileSync(join(SCRIPTS, rel), "utf8"));
      // `\.\.?/` because lib/sample.ts imports it as '../summary-findings.ts'
      // (one directory up) while the other two consumers import it as
      // './summary-findings.ts' (siblings) — both are the SAME file.
      expect(live).toMatch(
        /import\s*\{[^}]*\bTRUSTED_ASSOCIATIONS\b[^}]*\}\s*from\s*['"]\.\.?\/summary-findings\.ts['"]/,
      );
      // A local `const TRUSTED_ASSOCIATIONS = …` would shadow the import and
      // make it dead weight — the single-definition property would be false
      // despite the import statement still being present.
      expect(live).not.toMatch(/\bconst\s+TRUSTED_ASSOCIATIONS\s*=/);
      // And the import alone proves nothing if the call site stopped using it —
      // pin the exact expression that feeds the imported set into this
      // consumer's own trust check.
      const usage = USAGE[rel];
      if (usage === undefined) throw new Error(`no USAGE pattern for ${rel}`);
      expect(live).toMatch(usage);
    },
  );

  it("neither consumer spawns summary-findings.ts to read the vocabulary anymore", () => {
    for (const rel of CONSUMERS) {
      const live = stripLineComments(readFileSync(join(SCRIPTS, rel), "utf8"));
      expect(live).not.toContain("--trusted-associations");
    }
  });

  it("lib/sample.ts genuinely depends on the LIVE TRUSTED_ASSOCIATIONS object, not a same-valued copy", () => {
    // Same regression class as the subprocess mutation tests for the other
    // two consumers (announce-merge-ready.ts here in this file,
    // reconcile-replied-threads.ts in its own test file) — a local `new
    // Set(['OWNER', 'MEMBER', 'COLLABORATOR'])` in lib/sample.ts (its
    // pre-fix shape) would pass every text check above, because it agrees
    // with the export right now.
    //
    // lib/sample.ts has no CLI entry point (no `runMain`, unlike the other
    // two) — it is a plain library module, already imported at this file's
    // top level alongside `TRUSTED_ASSOCIATIONS` itself, both resolving to
    // the SAME `summary-findings.ts` module record. So this proves the
    // dependency the simplest way available for a pure function: mutate the
    // shared object directly and call `threadFrom` (which reaches
    // `TRUSTED_ASSOCIATIONS` through the private `settledFrom` helper) before
    // and after. A structurally separate copy would not observe the
    // deletion and would report the same outcome both times.
    const node = { id: "T-mutation", path: "a.ts", line: 1, isResolved: true };
    const comments = [
      {
        url: "https://example.invalid/1",
        authorAssociation: "MEMBER",
        createdAt: "2026-08-01T00:00:00Z",
        author: { login: "a-human", __typename: "User" },
        body: "**rejected** — already handled upstream.",
      },
    ];

    const baseline = threadFrom(node, comments, false);
    expect(baseline.outcome).toBe("rejected");

    expect(TRUSTED_ASSOCIATIONS.has("MEMBER")).toBe(true);
    TRUSTED_ASSOCIATIONS.delete("MEMBER");
    try {
      const mutated = threadFrom(node, comments, false);
      expect(mutated.outcome).toBeNull();
    } finally {
      // Restore — this Set is shared with every other test in this file via
      // the module cache; leaving it mutated would poison whatever runs next.
      TRUSTED_ASSOCIATIONS.add("MEMBER");
    }
  });
});

describe("no raw `gh` spawn escapes the deadline wrapper (#3995 round 17)", () => {
  // The bare binary in argv HEAD position — `['gh', …]` under
  // run()/spawn()/Bun.spawn(), or the (cmd, args) form `<anything>('gh', …)`.
  // Matching the argv head rather than the call name is what keeps prose like
  // "'gh' cannot report mergeability" inside a diagnostic string from being
  // read as a call site: those quote the word mid-sentence, never as the first
  // element of an array or argument list.
  //
  // ANY callee identifier, not the literal names `spawn`/`spawnSync`/
  // `execFile*`. Enumerating the API names left the import alias open —
  // `import { spawn as launch } from 'node:child_process'; launch('gh', args)`
  // matched neither pattern, and `GH_ALIAS` does not help because no variable
  // is bound to the string (docomply-review, a reference-implementation pull request round 2). Resolving
  // aliases would mean tracking imports; refusing to care what the callee is
  // called gets the same coverage with less machinery, because passing `'gh'`
  // as a first argument next to further arguments is not something any
  // NON-spawning call in these scripts does.
  const RAW_GH_SPAWN = /(?:\[|[A-Za-z_$][\w$]*\s*\()\s*(['"])gh\1\s*,/;

  // The one route a pattern on argv literals cannot follow is indirection:
  // `const GH = 'gh'; run([GH, …])` spawns the unbounded binary under a name
  // the sweep has no way to recognise. Rather than claim data-flow analysis
  // the sweep does not have, close the route at its source — binding the bare
  // string 'gh' to a name is itself the violation, and it is trivially
  // greppable. Only an assignment whose WHOLE value is 'gh' counts: the
  // diagnostic strings that merely mention gh mid-sentence must stay legal.
  const GH_ALIAS = /=\s*(['"])gh\1\s*[;,)\]]/;

  // A whole-line comment is documentation, not a call site, and this skill's
  // scripts document `gh`'s behaviour heavily. Blanked rather than DROPPED:
  // dropping shifts every following line number, and — since the scan below
  // spans newlines — would splice two real statements into a construct that
  // never existed in the source.
  function stripCommentLines(src: string): string {
    return src
      .split("\n")
      .map((line) => (/^\s*(?:\/\/|\*)/.test(line) ? "" : line))
      .join("\n");
  }

  // The scan runs over the WHOLE file, not line by line.
  //
  // A line-scoped scan only ever sees the spellings that happen to fit on one
  // line, and `run([\n  'gh',\n  'api',\n])` — exactly what the formatter
  // produces for any argv long enough to wrap — matches neither pattern on any
  // single line. So the precise unbounded spawn this gate exists to catch could
  // be introduced by an ordinary reformat with CI staying green
  // (docomply-review, a reference-implementation pull request round 1). Both patterns already tolerate
  // whitespace between the opener and the argv head, and `\s` spans newlines,
  // so scanning the joined source is the whole fix.
  function scanForRawGh(src: string): string[] {
    const code = stripCommentLines(src);
    const hits: { at: number; text: string }[] = [];
    for (const re of [RAW_GH_SPAWN, GH_ALIAS]) {
      for (const m of code.matchAll(new RegExp(re.source, "g"))) {
        hits.push({
          at: m.index,
          text: `${code.slice(0, m.index).split("\n").length}: ${m[0].replace(/\s+/g, " ").trim()}`,
        });
      }
    }
    return hits.sort((a, b) => a.at - b.at).map((h) => h.text);
  }

  // Files sanctioned to spawn `gh`: each root's own deadline chokepoint, plus
  // the one drive-pr script that predates the shared lib and carries its own.
  const ROOTS: ReadonlyArray<{
    label: string;
    dir: string;
    allowed: ReadonlySet<string>;
  }> = [
    {
      label: "drive-pr",
      dir: SCRIPTS,
      allowed: new Set(["lib/proc.ts"]),
    },
    {
      label: "resolve-review-comments",
      dir: join(
        import.meta.dir,
        "..",
        "..",
        "resolve-review-comments",
        "scripts",
      ),
      // A chokepoint per shape of caller: `lib/gh.ts` is the synchronous
      // spawn-print-exit helper for the straight-line scripts, `lib/proc.ts`
      // the async deadline runner the polling scripts (await-round.ts,
      // converge.ts, reply-to-thread.ts) took over from `lib/gh-deadline.sh`
      // when the skill's bash surface was ported to TypeScript.
      allowed: new Set(["lib/gh.ts", "lib/proc.ts"]),
    },
  ];

  // RECURSIVE, and derived from the filesystem rather than from a hand-listed
  // set of directories — a script added under any nested directory must be
  // swept without anyone remembering to add it (docomply-review, a reference-implementation pull request
  // round 18 caught the flat version of exactly this).
  const scan = (dir: string) =>
    [...new Bun.Glob("**/*.ts").scanSync(dir)]
      .sort()
      .map((rel) => ({ rel, path: join(dir, rel) }));
  const tsScripts = scan(SCRIPTS);

  // Guard the guard: an empty or mis-resolved file list would make every
  // assertion below vacuously pass, which is the failure mode a static sweep
  // is most prone to. The chokepoint and a nested lib file are named
  // explicitly, and the enumeration is cross-checked against an independent
  // walk rather than a hand-written floor.
  it("sweeps every TypeScript file under scripts/, recursively", () => {
    const rels = tsScripts.map((s) => s.rel);
    expect(rels).toContain("lib/proc.ts");
    expect(rels).toContain("lib/state/store.ts");
    expect(rels).toContain("announce-merge-ready.ts");
    // Second, independent enumeration: `find` walks the tree without sharing a
    // line of code with Bun.Glob, so a bug in either shows up as a disagreement.
    const viaFind = execFileSync(
      "find",
      [SCRIPTS, "-name", "*.ts", "-type", "f"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .map((p) => p.slice(SCRIPTS.length + 1))
      .sort();
    expect(rels).toEqual(viaFind);
  });

  // And no bash remains to sweep: the port is complete, not split across two
  // implementations that could drift.
  it("leaves no shell script under scripts/", () => {
    expect([...new Bun.Glob("**/*.sh").scanSync(SCRIPTS)]).toEqual([]);
  });

  for (const { label, dir, allowed } of ROOTS) {
    // Guard this root the same way: an empty list would make its whole sweep
    // vacuous, and a second root is exactly where a mis-resolved path hides.
    it(`${label}: the sweep resolves a non-empty script set`, () => {
      const rels = scan(dir).map((s) => s.rel);
      expect(rels.length).toBeGreaterThan(0);
      for (const a of allowed) expect(rels).toContain(a);
    });

    for (const { rel, path } of scan(dir)) {
      if (allowed.has(rel)) continue;
      it(`${label}/${rel} routes every outbound gh call through its deadline chokepoint`, () => {
        const offenders = scanForRawGh(readFileSync(path, "utf8")).map(
          (hit) => `${label}/${rel}:${hit}`,
        );
        expect(offenders).toEqual([]);
      });
    }
  }

  // And no bash remains under this root either: the whole surface —
  // await-round, converge, reply-to-thread, and the gh-deadline lib they
  // sourced — was ported to TypeScript, so `lib/proc.ts` is where their
  // deadline lives now and the sweep above covers every caller. One
  // implementation, one sweep, one claim. (The bash-era sweep and the
  // executed probes over `lib/gh-deadline.sh` retired with the port; their
  // measured behaviours — group kills, stdin preservation, trap restoration,
  // the alarm() range — are carried by lib/proc.ts and pinned by
  // resolve-review-comments' own suite.)
  it("leaves no shell script under resolve-review-comments/scripts/", () => {
    const rrc = ROOTS.find((r) => r.label === "resolve-review-comments");
    if (rrc === undefined)
      throw new Error("resolve-review-comments root missing");
    expect([...new Bun.Glob("**/*.sh").scanSync(rrc.dir)]).toEqual([]);
  });

  it("each chokepoint DOES spawn gh — the pattern is live, not vacuous", () => {
    for (const { label, dir, allowed } of ROOTS) {
      const spawning = [...allowed].filter(
        (rel) => scanForRawGh(readFileSync(join(dir, rel), "utf8")).length > 0,
      );
      expect({ label, spawning: spawning.length > 0 }).toEqual({
        label,
        spawning: true,
      });
    }
  });

  // The scanner IS the assertion above, so a typo in it makes every sweep
  // vacuously green. Each supported way of spelling the same unbounded spawn
  // gets its own probe rather than one probe for the spelling this repo
  // happens to use — and the probes drive `scanForRawGh`, not the bare regexes,
  // so the line splitting and comment stripping are covered too. A probe
  // against the raw pattern is what let the wrapped-argv escape ship: the
  // regexes were right, and the thing calling them was not.
  const MUST_MATCH: ReadonlyArray<readonly [string, string]> = [
    ["an argv array literal", "const r = await run(['gh', 'pr', 'view']);"],
    ["a double-quoted argv head", 'await run(["gh", "api", url]);'],
    ["Bun.spawn with an array", "Bun.spawn(['gh', ...args], opts)"],
    ["node spawn cmd/args form", "spawn('gh', args, opts)"],
    ["spawnSync cmd/args form", "spawnSync('gh', ['api'], opts)"],
    ["execFileSync", "execFileSync('gh', ['pr', 'view'])"],
    // The formatter's own output for a long argv — the escape this scan exists
    // to close. Every wrapped variant, because a fix that only handles the
    // array literal leaves the (cmd, args) forms open.
    [
      "a wrapped argv array literal",
      "const r = await run([\n  'gh',\n  'pr',\n  'view',\n]);",
    ],
    ["a wrapped spawnSync cmd/args form", "spawnSync(\n  'gh',\n  args,\n)"],
    ["a wrapped execFile form", "execFile(\n  'gh',\n  ['pr', 'view'],\n)"],
    // A comment BETWEEN the opener and the argv head is still a call site: the
    // blanking keeps the whitespace bridge intact rather than gluing unrelated
    // statements together.
    [
      "an argv head behind an interleaved comment",
      "run([\n  // the binary\n  'gh',\n  'api',\n])",
    ],
    ["a wrapped alias binding", "const GH =\n  'gh';"],
    // The decoy docomply-review asked for: an import alias defeats a matcher
    // that enumerates API names, and binds no variable for GH_ALIAS to catch.
    [
      "a spawn API imported under an alias",
      "import { spawn as launch } from 'node:child_process';\nlaunch('gh', args);",
    ],
    ["an aliased execFile, wrapped", "runIt(\n  'gh',\n  ['pr'],\n)"],
  ];
  for (const [label, src] of MUST_MATCH) {
    it(`the raw-gh scan matches ${label}`, () => {
      expect({ src, hits: scanForRawGh(src).length > 0 }).toEqual({
        src,
        hits: true,
      });
    });
  }

  const MUST_NOT_MATCH: ReadonlyArray<readonly [string, string]> = [
    ["the wrapped call", "const r = await ghCall(['pr', 'view', pr]);"],
    [
      "prose inside a quoted diagnostic",
      `reason = "this 'gh' cannot report mergeability — upgrade it";`,
    ],
    ["a lookalike argv head", "run(['ghost', 'api'])"],
    ["gh mid-argv, not the binary", "run(['echo', 'gh', 'api'])"],
    // Documentation, including the multi-line kind these scripts are full of.
    ["a commented-out call site", "// const r = await run(['gh', 'api']);"],
    [
      "a call site quoted inside a block comment",
      " * the bash version ran\n * spawnSync('gh', ['api'])\n */",
    ],
    // Two unrelated statements the blanking must not splice into one construct.
    [
      "adjacent statements that are not one call",
      "const a = [];\nconst b = 1;",
    ],
  ];
  for (const [label, src] of MUST_NOT_MATCH) {
    it(`the raw-gh scan does not match ${label}`, () => {
      expect({ src, hits: scanForRawGh(src) }).toEqual({ src, hits: [] });
    });
  }

  it("the alias pattern catches binding the bare binary to a name", () => {
    expect(GH_ALIAS.test("const GH = 'gh';")).toBe(true);
    expect(GH_ALIAS.test('const GH = "gh",')).toBe(true);
    expect(GH_ALIAS.test("run([GH_BIN = 'gh'])")).toBe(true);
    // Not every mention — only an assignment whose whole value is the binary.
    expect(GH_ALIAS.test("const tool = 'gh_call';")).toBe(false);
    expect(GH_ALIAS.test("const msg = 'run gh manually';")).toBe(false);
    expect(GH_ALIAS.test("GH_CALL_TIMEOUT = 30;")).toBe(false);
  });

  // The offender line number is the whole value of a failure report, and the
  // blank-don't-drop rule above is what keeps it true across stripped comments.
  it("reports the offender at its real line number", () => {
    const src = [
      "// a leading comment",
      "// and another",
      "const ok = 1;",
      "const r = await run(['gh', 'api']);",
    ].join("\n");
    expect(scanForRawGh(src)).toEqual(["4: ['gh',"]);
  });
});

describe("run distinguishes a failed spawn from a child that exits 127", () => {
  // PARITY PROBE. `spawnFailed` was added for /resolve-review-comments'
  // converge.ts, whose `proc.ts` is a hand-ported copy of this one; the copies
  // have no drift gate, so the same probe lives on both sides — that is the
  // closest thing to one (see this file's proc.ts header on the parity
  // contract).
  //
  // `run()` never rejects: a spawn error resolves as 127 with the error text on
  // stderr, because every bash call site read a missing command and a failed one
  // the same way. A caller that must know whether ANYTHING RAN cannot recover
  // that from `code`, and the pair below is why — a `code === 127` test passes
  // the first probe and FAILS the second.

  it("reports spawnFailed when the binary does not exist", async () => {
    const r = await run([join(tmpRoot, "no-such-binary-doc6893"), "arg"]);
    expect({ code: r.code, spawnFailed: r.spawnFailed }).toEqual({
      code: 127,
      spawnFailed: true,
    });
  });

  it("does NOT report spawnFailed when a real child exits 127 itself", async () => {
    const r = await run([process.execPath, "-e", "process.exit(127)"]);
    expect({ code: r.code, spawnFailed: r.spawnFailed }).toEqual({
      code: 127,
      spawnFailed: false,
    });
  });

  it("reports spawnFailed false for an ordinary successful child", async () => {
    const r = await run([process.execPath, "-e", "process.exit(0)"]);
    expect({ code: r.code, spawnFailed: r.spawnFailed }).toEqual({
      code: 0,
      spawnFailed: false,
    });
  });
});

describe("RunHandle.stop witnesses the process GROUP, not the signal", () => {
  /** Does any process remain in group `pgid`? ESRCH is the only "no". */
  function groupAlive(pgid: number): boolean {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  /**
   * A descendant that survives SIGTERM and outlives its own leader.
   *
   * The leader exits IMMEDIATELY, so `run()`'s 'close' — and therefore
   * `exited` — has already fired before `stop()` is ever called. The
   * descendant ignores SIGTERM in the shell AND re-runs `sleep` in a loop,
   * because `trap "" TERM` protects only the shell: a bare `sleep 5` is a
   * separate process that dies on the group SIGTERM, which would make the
   * group empty for the wrong reason and pass this test vacuously.
   */
  const LEADER_EXITS_DESCENDANT_LIVES =
    "sh -c 'trap \"\" TERM; n=0; while [ $n -lt 100 ]; do sleep 0.1; n=$((n+1)); done' & exit 0";

  it("resolves true only once no member of the group is left", async () => {
    let handle: RunHandle | undefined;
    const done = run(["sh", "-c", LEADER_EXITS_DESCENDANT_LIVES], {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
      onSpawn: (h) => {
        handle = h;
      },
    });
    const h = handle as RunHandle;
    const pgid = h.pid as number;
    expect(pgid).toBeGreaterThan(0);

    // The leader is gone almost at once, so `exited` — the thing both earlier
    // cuts resolved on — settles here, while the descendant is still running.
    await done;

    // Non-vacuous: the group must still be ALIVE at this point, or the test
    // would prove nothing about waiting for it.
    expect(groupAlive(pgid)).toBe(true);

    expect(await h.stop()).toBe(true);
    // And `true` means what it claims — no member of the group is left.
    expect(groupAlive(pgid)).toBe(false);
  });

  it("reports false rather than guessing when there is no group to witness", async () => {
    // A non-detached child shares OUR process group, so `kill(-pgid, 0)` would
    // answer about this test runner. There is nothing to witness, and the
    // honest answer is "not established" — which drive.ts reads as "do not
    // release the locks".
    let handle: RunHandle | undefined;
    const done = run(["sh", "-c", "exit 0"], {
      stdout: "ignore",
      stderr: "ignore",
      onSpawn: (h) => {
        handle = h;
      },
    });
    await done;
    expect(await (handle as RunHandle).stop()).toBe(false);
  });

  it("on Windows, fails closed when taskkill cannot be confirmed (e.g. missing on this platform)", async () => {
    // `detached` is forced false on win32 regardless of the option requested
    // (lib/proc.ts computes it from `process.platform` internally), so this
    // reproduces the exact real-world shape: a "detached" request that the
    // platform silently downgrades. A round-15 fix here reported the LEADER's
    // own exit as tree-wide evidence and returned `true` — but the leader can
    // exit via the SIGKILL escalation's `child.kill(sig)` ENOENT fallback
    // while a real Windows `taskkill /T /F` is still running or has silently
    // failed, so that was a false witness, not a real one (docomply-review /
    // chatgpt-codex-connector, a reference-implementation pull request round 16). `stop()` now awaits
    // taskkill's OWN exit code — on this POSIX runner `taskkill` does not
    // exist at all, so the honest, fail-closed answer is `false`, exercised
    // here exactly as it runs on every non-Windows CI box.
    const savedPlatform = process.platform;
    try {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      let handle: RunHandle | undefined;
      const done = run(["sh", "-c", "sleep 5"], {
        detached: true,
        stdout: "ignore",
        stderr: "ignore",
        onSpawn: (h) => {
          handle = h;
        },
      });
      expect(await (handle as RunHandle).stop()).toBe(false);
      await done;
    } finally {
      Object.defineProperty(process, "platform", {
        value: savedPlatform,
        configurable: true,
      });
    }
  });

  it("on Windows, treats a SUCCESSFUL taskkill exit as witnessed", async () => {
    // A controllable seam for the property round 16 asked to actually
    // validate: put a fake `taskkill` (any name lookup finds via PATH) in
    // front of the real one and control exactly what `stop()` awaits, rather
    // than inferring the tree's fate from the leader process alone.
    const fakeBinDir = mkdtempSync(join(tmpdir(), "fake-taskkill-"));
    const fakeTaskkill = join(fakeBinDir, "taskkill");
    // Really ends the target (`/pid <pid> /t /f`, so `$2` is the pid) —
    // otherwise the real leader keeps running for the test's full `sleep 5`
    // and `stop()`'s trailing `await exited` hangs regardless of what this
    // script reports, proving nothing about the exit-code path under test.
    writeFileSync(
      fakeTaskkill,
      '#!/bin/sh\nkill -9 "$2" 2>/dev/null\nexit 0\n',
    );
    chmodSync(fakeTaskkill, 0o755);
    const savedPath = process.env.PATH;
    const savedPlatform = process.platform;
    try {
      process.env.PATH = `${fakeBinDir}:${savedPath ?? ""}`;
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      let handle: RunHandle | undefined;
      const done = run(["sh", "-c", "sleep 5"], {
        detached: true,
        stdout: "ignore",
        stderr: "ignore",
        onSpawn: (h) => {
          handle = h;
        },
      });
      expect(await (handle as RunHandle).stop()).toBe(true);
      await done;
    } finally {
      process.env.PATH = savedPath;
      Object.defineProperty(process, "platform", {
        value: savedPlatform,
        configurable: true,
      });
      rmSync(fakeBinDir, { recursive: true, force: true });
    }
  });

  it("on Windows, fails closed when taskkill runs but exits with a genuine failure code", async () => {
    // Distinguishes "ran and failed" (a real problem) from "not found" (128,
    // treated as success — the tree it was asked to kill is already gone)
    // and from ENOENT (the previous test) — distinct signals the
    // implementation must not conflate.
    const fakeBinDir = mkdtempSync(join(tmpdir(), "fake-taskkill-fail-"));
    const fakeTaskkill = join(fakeBinDir, "taskkill");
    // Kills the target (so the test itself does not hang on the trailing
    // `await exited`) but still reports failure — a real `taskkill` could
    // plausibly end the leader while failing to confirm the whole tree, and
    // the exit code, not the leader's fate, is what `stop()` must trust.
    writeFileSync(
      fakeTaskkill,
      '#!/bin/sh\nkill -9 "$2" 2>/dev/null\nexit 1\n',
    );
    chmodSync(fakeTaskkill, 0o755);
    const savedPath = process.env.PATH;
    const savedPlatform = process.platform;
    try {
      process.env.PATH = `${fakeBinDir}:${savedPath ?? ""}`;
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      let handle: RunHandle | undefined;
      const done = run(["sh", "-c", "sleep 5"], {
        detached: true,
        stdout: "ignore",
        stderr: "ignore",
        onSpawn: (h) => {
          handle = h;
        },
      });
      expect(await (handle as RunHandle).stop()).toBe(false);
      await done;
    } finally {
      process.env.PATH = savedPath;
      Object.defineProperty(process, "platform", {
        value: savedPlatform,
        configurable: true,
      });
      rmSync(fakeBinDir, { recursive: true, force: true });
    }
  });

  it("treats a ZOMBIE-only group as gone rather than waiting out the full witness window", async () => {
    // `kill(-pgid, 0)` cannot tell a zombie from a running process — a
    // zombie still occupies a process-table slot until reaped, so it
    // answers "still alive" exactly like a live one. A child spawned under
    // a container PID 1 that does not reap orphans leaves a SIGKILLed
    // descendant a zombie indefinitely, stranding `groupAlive`'s own test
    // (and this port's `groupGone()`) for the FULL `STOP_WITNESS_MS`.
    //
    // `DRIVE_PR_PROC_ROOT` overrides which `/proc`-shaped tree the zombie
    // check reads — pointed at a fixture instead of the real kernel one, so
    // this is deterministic regardless of host platform: the REAL group
    // below stays genuinely alive (via `LEADER_EXITS_DESCENDANT_LIVES` —
    // NOT a bare `trap "" TERM; sleep N`, which that fixture's own doc
    // comment already explains dies on the group SIGTERM regardless of the
    // trap, since the trap protects only the shell and a plain `sleep` is a
    // separate process) so `groupGone()`'s own real-OS check still reports
    // "not gone" first, exactly as it does in production, and only the
    // FIXTURE tree — entirely separate from whatever `/proc` the real
    // spawned process actually lives under — supplies the "no live member"
    // answer `hasLiveGroupMember` needs to return `true` early.
    const procRoot = mkdtempSync(join(tmpdir(), "fake-proc-"));
    const savedProcRoot = process.env.DRIVE_PR_PROC_ROOT;
    let handle: RunHandle | undefined;
    const done = run(["sh", "-c", LEADER_EXITS_DESCENDANT_LIVES], {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
      onSpawn: (h) => {
        handle = h;
      },
    });
    const h = handle as RunHandle;
    const pgid = h.pid as number;
    expect(pgid).toBeGreaterThan(0);
    try {
      const fakeZombieDir = join(procRoot, "999999");
      mkdirSync(fakeZombieDir, { recursive: true });
      // Fields after the `(comm)` split: state, ppid, pgrp — only the first
      // three matter to the parser under test. `Z` is the kernel's own
      // zombie state code.
      writeFileSync(
        join(fakeZombieDir, "stat"),
        `999999 (fakezombie) Z 1 ${pgid} 1\n`,
      );
      process.env.DRIVE_PR_PROC_ROOT = procRoot;

      // Non-vacuous: the REAL group must still be alive at this point, or
      // the fixture below is never actually exercised.
      expect(groupAlive(pgid)).toBe(true);

      const start = Date.now();
      const witnessed = await h.stop();
      const elapsedMs = Date.now() - start;
      expect(witnessed).toBe(true);
      // Well under STOP_WITNESS_MS (30_000): the fix means this resolves on
      // roughly the first poll tick, not after waiting out the window.
      expect(elapsedMs).toBeLessThan(5000);
    } finally {
      if (savedProcRoot === undefined) delete process.env.DRIVE_PR_PROC_ROOT;
      else process.env.DRIVE_PR_PROC_ROOT = savedProcRoot;
      rmSync(procRoot, { recursive: true, force: true });
      // The whole point of this test is that `stop()` clears the backstop
      // SIGKILL timer once it confirms termination via the fixture tree —
      // so unlike every other test in this file, nothing here ever sends a
      // REAL kill to the REAL process, which the loop keeps alive for up to
      // 10s on its own. Without this, `await done` would block for the
      // remainder of that loop.
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        // already gone
      }
      await done;
    }
  });

  describe("hasLiveGroupMemberLinux — ENOENT is the only skippable read failure", () => {
    // Hermetic and platform-independent by construction: no process is
    // spawned, no `ps` fallback is exercised, and `DRIVE_PR_PROC_ROOT`
    // fully replaces the tree this function reads. An earlier version of
    // this coverage drove the same question through a real spawned process
    // plus `stop()`'s `ps` fallback and failed unpredictably across hosts
    // (a local run and a remote Linux run each surfaced `witnessed: true`
    // in under 30ms for reasons that traced back to that fallback's own
    // cross-host variables, never to this function) — this direct test is
    // what replaced it, per that function's own "exported for exactly
    // this" doc comment.
    let procRoot: string;
    let savedProcRoot: string | undefined;

    function makeStatFile(dir: string, name: string, content: string): void {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, "stat"), content);
    }

    beforeEach(() => {
      procRoot = mkdtempSync(join(tmpdir(), "fake-proc-hlgml-"));
      savedProcRoot = process.env.DRIVE_PR_PROC_ROOT;
      process.env.DRIVE_PR_PROC_ROOT = procRoot;
    });

    afterEach(() => {
      if (savedProcRoot === undefined) delete process.env.DRIVE_PR_PROC_ROOT;
      else process.env.DRIVE_PR_PROC_ROOT = savedProcRoot;
      rmSync(procRoot, { recursive: true, force: true });
    });

    it("returns true for an ordinary live (non-zombie) member", () => {
      makeStatFile(procRoot, "111", "111 (proc) S 1 424242 1\n");
      expect(hasLiveGroupMemberLinux(424242)).toBe(true);
    });

    it("returns false when the only member is a zombie", () => {
      makeStatFile(procRoot, "111", "111 (proc) Z 1 424242 1\n");
      expect(hasLiveGroupMemberLinux(424242)).toBe(false);
    });

    it("returns false when no entry matches the pgid at all", () => {
      makeStatFile(procRoot, "111", "111 (proc) S 1 999999 1\n");
      expect(hasLiveGroupMemberLinux(424242)).toBe(false);
    });

    it("skips an entry that vanished between readdir and read (ENOENT) and keeps scanning", () => {
      // A real ENOENT — `mkdirSync` for the entry's OWN directory runs, but
      // no `stat` file is ever written inside it — is exactly what a pid
      // reaped between `readdirSync` and this read looks like: the
      // directory (or its contents) is gone by the time the read happens.
      mkdirSync(join(procRoot, "111"), { recursive: true });
      makeStatFile(procRoot, "222", "222 (proc) S 1 424242 1\n");
      expect(hasLiveGroupMemberLinux(424242)).toBe(true);
    });

    it("bails to null — never false — on a read failure that is NOT the pid exiting", () => {
      // A DIRECTORY named `stat`, not a file: `readFileSync` throws
      // EISDIR, never ENOENT — standing in for EMFILE/EIO under real load,
      // which says nothing about whether the pid it belongs to is alive.
      // Every OTHER unanswerable case in this file fails toward "still
      // alive" (`groupGone`'s EPERM branch, an unreadable `procRoot()`, a
      // failed `ps`) — silently treating this one as "not a live member"
      // would be the sole exception, manufacturing a false "confirmed
      // gone" from one unrelated unreadable entry.
      mkdirSync(join(procRoot, "888888", "stat"), { recursive: true });
      expect(hasLiveGroupMemberLinux(424242)).toBe(null);
    });

    it("bails to null regardless of scan order, as long as no OTHER entry ever resolves live", () => {
      // Directory-entry order is not alphabetical and is not controlled by
      // this fixture (measured: a real difference between two hosts'
      // filesystems visited these two entries in opposite orders). A
      // GENUINELY LIVE sibling entry would be a poor choice here — reaching
      // it first safely short-circuits to `true`, which is not the unsafe
      // outcome this test guards against, so an order-dependent test built
      // on one would assert an implementation detail neither order needs to
      // honour. A ZOMBIE sibling has no such early-return branch (it only
      // ever `continue`s), so the unreadable entry is the ONLY one able to
      // end the scan early, whichever order the two are visited in — this
      // fixture is genuinely order-independent, not order-independent by
      // coincidence of iteration.
      mkdirSync(join(procRoot, "888888", "stat"), { recursive: true });
      makeStatFile(procRoot, "999999", "999999 (proc) Z 1 424242 1\n");
      expect(hasLiveGroupMemberLinux(424242)).toBe(null);
    });

    it("returns null when procRoot() itself cannot be listed", () => {
      rmSync(procRoot, { recursive: true, force: true });
      expect(hasLiveGroupMemberLinux(424242)).toBe(null);
    });
  });

  it("cancels the pending backstop SIGKILL once termination is CONFIRMED, so it cannot later target a reused PGID", async () => {
    // The leader is already gone by the time `stop()` is ever called —
    // reproducing the exact race the finding describes: `close` fires and
    // `settle` clears whatever timer it finds live BEFORE `doStop` ever
    // runs, so a timer `doStop` installs afterwards has nothing else to
    // clear it.
    let handle: RunHandle | undefined;
    const done = run(["sh", "-c", "exit 0"], {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
      onSpawn: (h) => {
        handle = h;
      },
    });
    const h = handle as RunHandle;
    const pgid = h.pid as number;
    await done;
    expect(groupAlive(pgid)).toBe(false);

    const killSpy = spyOn(process, "kill");
    try {
      expect(await h.stop()).toBe(true);
      // Past STOP_ESCALATE_MS (2s) plus slack: the unfixed code left a
      // fresh `setTimeout(() => signalTree('SIGKILL'), STOP_ESCALATE_MS)`
      // armed and uncleared for exactly this "already gone on the first
      // check" case, firing a SIGKILL at a PGID the kernel may since have
      // reassigned to an unrelated process.
      await new Promise((r) => setTimeout(r, 2500));
      const staleKill = killSpy.mock.calls.some(
        (args) => args[0] === -pgid && args[1] === "SIGKILL",
      );
      expect(staleKill).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe("parsePsStatRows — the macOS/BSD zombie-liveness fallback parser", () => {
  it("parses pid, pgid and stat from ordinary `ps -A -o pid=,pgid=,stat=` output", () => {
    expect(parsePsStatRows(" 123  123 Ss+\n 456  123 R+\n")).toEqual([
      { pid: 123, pgid: 123, stat: "Ss+" },
      { pid: 456, pgid: 123, stat: "R+" },
    ]);
  });

  it("recognises a zombie by the leading Z, whatever follows it", () => {
    expect(parsePsStatRows(" 789  123 Z\n")[0]?.stat.startsWith("Z")).toBe(
      true,
    );
    expect(parsePsStatRows(" 789  123 Zombie\n")[0]?.stat.startsWith("Z")).toBe(
      true,
    );
  });

  it("skips blank lines and rows missing a required column", () => {
    expect(parsePsStatRows("\n  \n 1 2\n 1 2 R\n")).toEqual([
      { pid: 1, pgid: 2, stat: "R" },
    ]);
  });

  it("skips a row whose pid/pgid column is not numeric", () => {
    expect(parsePsStatRows(" PID  PGID STAT\n 1 2 R\n")).toEqual([
      { pid: 1, pgid: 2, stat: "R" },
    ]);
  });
});

describe("sleep — abortable", () => {
  it("resolves early, without throwing, when the signal aborts mid-wait", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const p = sleep(30, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(p).resolves.toBeUndefined();
    // Nowhere near the full 30s the delay asked for.
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("waits out the full delay when never aborted", async () => {
    const controller = new AbortController();
    const start = Date.now();
    await sleep(0.05, controller.signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it("behaves exactly as before when no signal is passed at all", async () => {
    const start = Date.now();
    await sleep(0.05);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });
});

// ── Cancellation forwarding ──────────────────────────────────────

/**
 * A deadlined child is DETACHED into its own process group so the deadline can
 * kill the whole tree. That isolation also puts it beyond the reach of a signal
 * delivered to this process, or to its group — so without `lib/proc.ts`'s
 * source-time forwarding, terminating a driver leaves the in-flight call
 * running to completion: `guarded-push.ts`'s `git push` lands after the
 * operator believes the operation was cancelled (chatgpt-codex-connector,
 * a reference-implementation pull request against the bash `gh-deadline.sh` → an earlier change, which measured the
 * same hole in this port — the subshell that finding named is gone, the
 * isolated group it was compounded by is not).
 *
 * End-to-end by necessity: the claim is about what a SEPARATE process does when
 * the kernel delivers it a TERM, which no in-process assertion can reach. Each
 * probe spawns a fixture that starts a child, waits for that child to prove
 * itself live, TERMs the fixture, and asserts on what the child did NOT go on
 * to do. Mirrors resolve-review-comments' suite, per the parity-copy rule in
 * `lib/proc.ts`'s header.
 */
describe("cancellation reaches a deadlined child", () => {
  const PROC = join(SCRIPTS, "lib", "proc.ts");

  interface Probe {
    /** Did the child run to completion after the fixture was killed? */
    completed: boolean;
    /** Did the fixture's OWN handler run? */
    ownHandlerRan: boolean;
    signal: string | null;
    code: number | null;
  }

  /**
   * `runOpts` is spliced into the fixture verbatim, so one fixture covers both
   * the library-detached child (a deadline) and the caller-owned one (an
   * explicit `detached` / `onSpawn`), which the forwarding deliberately leaves
   * alone.
   */
  async function probe(opts: {
    ownHandler: boolean;
    runOpts: string;
  }): Promise<Probe> {
    const dir = mkdtempSync(join(tmpdir(), "drive-cancel-"));
    const live = join(dir, "live");
    const completed = join(dir, "completed");
    const ownRan = join(dir, "own-handler-ran");
    // The child announces itself LIVE before sleeping, so the probe never races
    // the spawn: a TERM delivered before the child existed would leave nothing
    // to forward to and pass vacuously.
    const script = `: > ${JSON.stringify(live)}; sleep 3; : > ${JSON.stringify(completed)}`;
    writeFileSync(
      join(dir, "fixture.ts"),
      [
        `import { run } from ${JSON.stringify(PROC)};`,
        `import { writeFileSync } from 'node:fs';`,
        opts.ownHandler
          ? `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(ownRan)}, ''); process.exit(9); });`
          : "",
        `await run(['bash', '-c', ${JSON.stringify(script)}], ${opts.runOpts});`,
      ].join("\n"),
    );

    const child = spawn(process.execPath, [join(dir, "fixture.ts")], {
      cwd: dir,
      env: gitCleanEnv(),
      stdio: "ignore",
    });
    const ended = new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => {
        child.on("close", (code, signal) => resolve({ code, signal }));
      },
    );

    const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 200 && !existsSync(live); i++) await nap(25);
    const wasLive = existsSync(live);
    child.kill("SIGTERM");
    const exit = await ended;
    // Outlive the child's own `sleep 3`: the assertion is that it never
    // completes, which is only meaningful once it would have.
    await nap(4000);

    const result: Probe = {
      completed: existsSync(completed),
      ownHandlerRan: existsSync(ownRan),
      signal: exit.signal,
      code: exit.code,
    };
    rmSync(dir, { recursive: true, force: true });
    // Thrown rather than folded into the result, so a fixture whose child never
    // started fails loudly instead of silently satisfying `completed: false`.
    if (!wasLive) throw new Error("probe child never became live");
    return result;
  }

  it("kills the in-flight deadlined child instead of letting it complete", async () => {
    const r = await probe({ ownHandler: false, runOpts: "{ timeoutSec: 60 }" });
    expect({ completed: r.completed, signal: r.signal }).toEqual({
      completed: false,
      // Re-raised: with no caller handler the forwarding removes itself and
      // signals this process again, so it dies from the TERM exactly as it
      // would have with no handler installed. That is what keeps a
      // cancellation unmaskable by a caller that swallowed the RunResult.
      signal: "SIGTERM",
    });
  });

  it("preserves the caller's own handler while still killing the child", async () => {
    const r = await probe({ ownHandler: true, runOpts: "{ timeoutSec: 60 }" });
    expect({
      completed: r.completed,
      ownHandlerRan: r.ownHandlerRan,
      code: r.code,
    }).toEqual({
      completed: false,
      ownHandlerRan: true,
      // The caller's handler owns the outcome once it exists — no re-raise, and
      // its own exit code, not the signal's (the #3997 guarantee).
      code: 9,
    });
  });

  it("keeps forwarding a second signal when the caller handler does not exit", async () => {
    // Regression for the bug this hardening fixed: `forward` used to
    // remove itself unconditionally after the FIRST occurrence of a signal,
    // regardless of whether other listeners were still present. A caller that
    // handles or debounces a signal without exiting — modelled here by an own
    // handler that never calls `process.exit()` — silently regained the
    // original unforwarded-cancellation bug for every signal after the first.
    // Two deadlined children run in sequence so the SECOND SIGTERM has a live
    // tracked group to prove was (or was not) forwarded.
    const dir = mkdtempSync(join(tmpdir(), "drive-cancel-repeat-"));
    const liveA = join(dir, "liveA");
    const completedA = join(dir, "completedA");
    const liveB = join(dir, "liveB");
    const completedB = join(dir, "completedB");
    const phase2 = join(dir, "phase2-ready");
    const scriptA = `: > ${JSON.stringify(liveA)}; sleep 3; : > ${JSON.stringify(completedA)}`;
    const scriptB = `: > ${JSON.stringify(liveB)}; sleep 3; : > ${JSON.stringify(completedB)}`;
    writeFileSync(
      join(dir, "fixture.ts"),
      [
        `import { run } from ${JSON.stringify(PROC)};`,
        `import { writeFileSync } from 'node:fs';`,
        `process.on('SIGTERM', () => {});`,
        `async function main() {`,
        `  await run(['bash', '-c', ${JSON.stringify(scriptA)}], { timeoutSec: 60 });`,
        `  writeFileSync(${JSON.stringify(phase2)}, '');`,
        `  await run(['bash', '-c', ${JSON.stringify(scriptB)}], { timeoutSec: 60 });`,
        `}`,
        `main();`,
      ].join("\n"),
    );

    const child = spawn(process.execPath, [join(dir, "fixture.ts")], {
      cwd: dir,
      env: gitCleanEnv(),
      stdio: "ignore",
    });
    const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));
    try {
      for (let i = 0; i < 200 && !existsSync(liveA); i++) await nap(25);
      if (!existsSync(liveA))
        throw new Error("fixture child A never became live");
      child.kill("SIGTERM");

      for (let i = 0; i < 200 && !existsSync(phase2); i++) await nap(25);
      if (!existsSync(phase2)) {
        throw new Error("fixture did not resume after the first SIGTERM");
      }

      for (let i = 0; i < 200 && !existsSync(liveB); i++) await nap(25);
      if (!existsSync(liveB))
        throw new Error("fixture child B never became live");
      child.kill("SIGTERM");

      // Outlive child B's own `sleep 3`: the assertion is that it never
      // completes, which is only meaningful once it would have.
      await nap(4000);

      expect(existsSync(completedA)).toBe(false);
      expect(existsSync(completedB)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a caller-owned child to its caller", async () => {
    // `detached` + `onSpawn` is drive.ts's pass: the caller took the handle and
    // orders its own `stop()` against the lock release, on a 2s grace. The
    // library must NOT pre-empt that by SIGKILLing a mid-edit agent on its own
    // 250ms one — so a fixture that takes the handle and then exits without
    // stopping leaks the child BY CONTRACT. Asserting the leak is what pins the
    // boundary; widening the forwarding to cover these would flip this test.
    const r = await probe({
      ownHandler: true,
      runOpts: "{ detached: true, onSpawn: () => {} }",
    });
    expect({ completed: r.completed, ownHandlerRan: r.ownHandlerRan }).toEqual({
      completed: true,
      ownHandlerRan: true,
    });
  });
});

// ── Buffer cap ───

/**
 * Ported from the sibling `/resolve-review-comments` copy of `lib/proc.ts`
 * (docomply-review / chatgpt-codex-connector, a reference-implementation pull request round 3): this file's
 * `run()` had the same unbounded `out += d` / `err += d` accumulation, on
 * every `ghCall()`/`git()` path in this skill's own loop.
 *
 * "Later chunks are excluded" is asserted directly off `onChunk`'s per-chunk
 * captured/discarded record rather than inferred from a captured byte-count
 * bound — a real OS pipe's read chunking varies enough in practice (a single
 * burst measured ~250 KiB in the sibling copy's own probe) that any fixed
 * bound is either loose enough to miss a partial regression or tight enough
 * to flake on legitimate variance.
 */
describe("run's output cap kills a runaway child", () => {
  const PROC = join(SCRIPTS, "lib", "proc.ts");
  const MAX_BUFFER_BYTES_TEST = 8192;
  // A sanity ceiling only — not the primary proof (see `discardedChunks`
  // below) — wide enough that legitimate OS pipe chunking variance across
  // machines never trips it, while still ruling out the catastrophic
  // regression class: an UNGUARDED child left running for the same
  // two-second SIGKILL grace this probe exercises captures on the order of a
  // HUNDRED MEGABYTES (measured in the sibling copy's own probe), thousands
  // of times past this ceiling.
  const SANITY_CEILING = MAX_BUFFER_BYTES_TEST + 4 * 1024 * 1024;

  /**
   * @param ignoreTerm When true, the child traps and swallows SIGTERM so only
   *   the escalation's SIGKILL two seconds later actually ends it — the exact
   *   window in which unguarded capture used to keep growing.
   */
  async function probeBufferCap(opts: {
    ignoreTerm: boolean;
  }): Promise<{ result: Record<string, unknown>; completed: boolean }> {
    const dir = mkdtempSync(join(tmpdir(), "drive-buffer-"));
    const completed = join(dir, "completed");
    // Writes 1 KiB chunks forever until killed; `completed` only appears if
    // the loop is allowed to finish on its own, which the cap must prevent.
    // A `while` counter at a count high enough that a fast CI runner cannot
    // finish it naturally within the ~2s SIGKILL grace, not `for i in
    // $(seq 1 1000000)`: nothing throttles a discarded-past-the-cap child's
    // write rate (the pipe is drained continuously, just not captured), so a
    // sufficiently fast machine completed 1,000,000 tight-loop iterations —
    // `completed` existed — inside the grace window, failing the assertion
    // that `ignoreTerm: true` is never allowed to finish on its own
    // (measured in CI, not locally: PR #4054's own `code-quality-and-build`
    // run, sibling `/resolve-review-comments` copy). A count also high
    // enough that `$(seq ...)` would materialise the whole number list
    // before the loop's first write, which the `while` form avoids.
    const trap = opts.ignoreTerm ? "trap '' TERM; " : "";
    const script = `${trap}i=0; while [ "$i" -lt 100000000 ]; do printf '%01024d' 0; i=$((i + 1)); done; : > ${JSON.stringify(completed)}`;
    writeFileSync(
      join(dir, "fixture.ts"),
      [
        `import { run } from ${JSON.stringify(PROC)};`,
        `let discardedChunks = 0;`,
        `let discardedBytes = 0;`,
        `const r = await run(['bash', '-c', ${JSON.stringify(script)}], {`,
        `  timeoutSec: 60,`,
        `  maxBufferBytes: ${MAX_BUFFER_BYTES_TEST},`,
        `  onChunk: (_stream, bytes, captured) => {`,
        `    if (!captured) { discardedChunks++; discardedBytes += bytes; }`,
        `  },`,
        `});`,
        `process.stdout.write(JSON.stringify({ code: r.code, timedOut: r.timedOut, bufferExceeded: r.bufferExceeded, stdoutLength: r.stdout.length, discardedChunks, discardedBytes }));`,
      ].join("\n"),
    );

    const out = execFileSync(process.execPath, [join(dir, "fixture.ts")], {
      cwd: dir,
      env: gitCleanEnv(),
      encoding: "utf8",
      timeout: 15_000,
    });
    const result = JSON.parse(out);
    const stillCompleted = existsSync(completed);
    rmSync(dir, { recursive: true, force: true });
    return { result, completed: stillCompleted };
  }

  it("kills the child and reports bufferExceeded once captured output crosses the cap", async () => {
    const { result, completed } = await probeBufferCap({ ignoreTerm: false });

    expect({
      code: result.code,
      timedOut: result.timedOut,
      bufferExceeded: result.bufferExceeded,
      completed,
    }).toEqual({
      code: 1,
      timedOut: false,
      bufferExceeded: true,
      completed: false,
    });
    expect(result.stdoutLength as number).toBeLessThan(SANITY_CEILING);
  });

  it("discards every chunk offered after the cap trips, even when the child ignores SIGTERM through the SIGKILL grace", async () => {
    const { result, completed } = await probeBufferCap({ ignoreTerm: true });

    expect({
      code: result.code,
      timedOut: result.timedOut,
      bufferExceeded: result.bufferExceeded,
      completed,
    }).toEqual({
      code: 1,
      timedOut: false,
      bufferExceeded: true,
      completed: false,
    });
    // The child kept writing for the whole two-second grace before SIGKILL
    // landed, so `onChunk` must have SEEN further chunks arrive — and this is
    // the direct proof they were rejected rather than captured.
    expect(result.discardedChunks as number).toBeGreaterThan(0);
    expect(result.discardedBytes as number).toBeGreaterThan(0);
    expect(result.stdoutLength as number).toBeLessThan(SANITY_CEILING);
  });

  it("also stops capturing once the DEADLINE (not the buffer cap) trips, through its own SIGKILL grace", async () => {
    // The capture guard used to key only on `bufferExceeded`, so a child that
    // hits the DEADLINE first kept being captured for the whole two-second
    // deadline escalation — an 8 KiB cap stayed unenforced against a
    // multi-megabyte post-timeout flood (chatgpt-codex-connector, a reference-implementation pull request
    // round 4).
    //
    // A THROTTLED writer, not a tight loop under a huge `maxBufferBytes`: an
    // earlier version of this probe let a tight loop run unthrottled under a
    // 1 GiB cap so only the deadline could trigger — but the loop's own
    // measured ~100+ MB/s rate meant `r.stdout` legitimately retained tens to
    // hundreds of megabytes for the whole test, real memory pressure this
    // suite doesn't need (duplicated again here, on top of the sibling
    // `/resolve-review-comments` copy), and on a fast enough or
    // memory-constrained runner it could OOM, or cross even 1 GiB before the
    // 1-second deadline and flip `bufferExceeded` instead of `timedOut`,
    // failing the very assertion below it (docomply-review, a reference-implementation pull request
    // round 5). A small, slow, bounded write rate proves the exact same
    // thing — chunks arriving during the deadline's escalation are
    // discarded — without either risk.
    const dir = mkdtempSync(join(tmpdir(), "drive-buffer-"));
    const completed = join(dir, "completed");
    // ~50 writes/sec of 64 bytes each — keeps going (SIGTERM trapped) through
    // the full 1s deadline + 2s grace, but never accumulates more than a few
    // hundred bytes before the deadline and a similar amount discarded after.
    const script = `trap '' TERM; while true; do printf '%064d' 0; sleep 0.02; done; : > ${JSON.stringify(completed)}`;
    writeFileSync(
      join(dir, "fixture.ts"),
      [
        `import { run } from ${JSON.stringify(PROC)};`,
        `let discardedChunks = 0;`,
        `let discardedBytes = 0;`,
        `const r = await run(['bash', '-c', ${JSON.stringify(script)}], {`,
        `  timeoutSec: 1,`,
        `  onChunk: (_stream, bytes, captured) => {`,
        `    if (!captured) { discardedChunks++; discardedBytes += bytes; }`,
        `  },`,
        `});`,
        `process.stdout.write(JSON.stringify({ code: r.code, timedOut: r.timedOut, bufferExceeded: r.bufferExceeded, stdoutLength: r.stdout.length, discardedChunks, discardedBytes }));`,
      ].join("\n"),
    );

    const out = execFileSync(process.execPath, [join(dir, "fixture.ts")], {
      cwd: dir,
      env: gitCleanEnv(),
      encoding: "utf8",
      timeout: 15_000,
    });
    const result = JSON.parse(out);
    const stillCompleted = existsSync(completed);
    rmSync(dir, { recursive: true, force: true });

    expect({
      code: result.code,
      timedOut: result.timedOut,
      bufferExceeded: result.bufferExceeded,
      completed: stillCompleted,
    }).toEqual({
      code: 124,
      timedOut: true,
      bufferExceeded: false,
      completed: false,
    });
    // The child kept writing through the deadline's own two-second grace, so
    // `onChunk` must have seen — and discarded — further chunks.
    expect(result.discardedChunks as number).toBeGreaterThan(0);
    expect(result.discardedBytes as number).toBeGreaterThan(0);
    // Sanity, not the primary proof: at ~50 writes/sec this stays a few
    // hundred bytes even over 3 real seconds, nowhere near a real cap.
    expect(result.stdoutLength as number).toBeLessThan(64 * 1024);
  });
});

describe("markReadyTimeoutSeconds() outlives mark-ready.ts's own worst-case sequential budget (docomply-review rounds 21-22, PR #4057)", () => {
  const PROC = join(SCRIPTS, "lib", "proc.ts");

  function readTimeouts(env: Record<string, string>): {
    helper: number;
    gh: number;
    markReady: number;
  } {
    // Exercised in a separate process (not imported in-process) because these
    // accessors can call fail() -> process.exit() on a malformed env value,
    // which must never risk killing the test runner itself.
    const dir = mkdtempSync(join(tmpdir(), "drive-mark-ready-timeout-"));
    writeFileSync(
      join(dir, "fixture.ts"),
      [
        `import { ghCallTimeoutSeconds, helperTimeoutSeconds, markReadyTimeoutSeconds } from ${JSON.stringify(PROC)};`,
        `process.stdout.write(JSON.stringify({ helper: helperTimeoutSeconds(), gh: ghCallTimeoutSeconds(), markReady: markReadyTimeoutSeconds() }));`,
      ].join("\n"),
    );
    const out = execFileSync(process.execPath, [join(dir, "fixture.ts")], {
      cwd: dir,
      env: { ...gitCleanEnv(), ...env },
      encoding: "utf8",
      timeout: 15_000,
    });
    rmSync(dir, { recursive: true, force: true });
    return JSON.parse(out) as { helper: number; gh: number; markReady: number };
  }

  it("is the COMPLETE derived bound — four helper-bound calls plus three gh-bound calls plus escalation grace, not a flat multiplier", () => {
    // drive.ts spawns mark-ready.ts with helperTimeoutSeconds() alone used to
    // bound that whole spawn — but mark-ready.ts's dispatch path is up to
    // SEVEN sequential network calls, each individually entitled to its own
    // full budget: ready-marked, the initial readSnapshot, claim-ready-mark,
    // renew-ready-mark, gh pr ready itself, the ambiguous-path follow-up
    // readSnapshot, and commit-ready-mark. A parent timeout that undercounts
    // this chain can kill mark-ready.ts after gh pr ready applied
    // server-side but before commit-ready-mark persists that fact, so once
    // the claim lease then expires a later re-drafted PR can fire
    // ready_for_review a second time.
    //
    // A prior version of this fix used a flat `4 * helper` multiplier, which
    // only happened to clear the real chain (4 helper calls + 3 gh calls) at
    // the DEFAULT 120s/30s ratio — this asserts the actual formula so a
    // config that skews that ratio can't silently fall short again.
    const result = readTimeouts({
      DRIVE_PR_HELPER_TIMEOUT: "120",
      GH_CALL_TIMEOUT: "30",
    });
    expect(result.helper).toBe(120);
    expect(result.gh).toBe(30);
    // 4 helper-bound + 3 gh-bound + 7 * 2s escalation grace.
    expect(result.markReady).toBe(4 * 120 + 3 * 30 + 7 * 2);
  });

  it("does not silently fall short when GH_CALL_TIMEOUT is skewed far above the helper/gh default ratio", () => {
    // The regression a flat `helper * 4` multiplier could reintroduce: with
    // GH_CALL_TIMEOUT configured much larger relative to
    // DRIVE_PR_HELPER_TIMEOUT than the 120s/30s default, three gh-bound calls
    // alone can exceed a flat 4x-of-helper bound. The derived sum tracks
    // whichever unit actually grows.
    const result = readTimeouts({
      DRIVE_PR_HELPER_TIMEOUT: "10",
      GH_CALL_TIMEOUT: "60",
    });
    expect(result.helper).toBe(10);
    expect(result.gh).toBe(60);
    expect(result.markReady).toBe(4 * 10 + 3 * 60 + 7 * 2);
    // The regression case, stated directly: a flat 4x-of-helper bound (40)
    // would be far short of what this chain can actually take.
    expect(result.markReady).toBeGreaterThan(result.helper * 4);
  });

  it("clamps to the 32-bit-safe ceiling instead of overflowing when summed (docomply-review round 22, a reference-implementation pull request)", () => {
    // helperTimeoutSeconds() individually refuses a value whose OWN `* 1000`
    // would overflow setTimeout's 32-bit signed millisecond delay — but
    // markReadyTimeoutSeconds() sums up to seven of them, so an individually
    // VALID DRIVE_PR_HELPER_TIMEOUT can still produce a total that overflows
    // here even though helperTimeoutSeconds() itself never saw an invalid
    // value. 600000s comfortably clears helperTimeoutSeconds()'s own
    // ~2147483s ceiling, but 4 * 600000 * 1000 = 2.4 billion ms overflows the
    // 32-bit delay a caller eventually passes this value to — silently
    // firing the deadline immediately rather than refusing loudly, three
    // calls away from here. A derived internal value has no user to refuse,
    // so it clamps to the same 32-bit ceiling instead of overflowing past it.
    const result = readTimeouts({
      DRIVE_PR_HELPER_TIMEOUT: "600000",
      GH_CALL_TIMEOUT: "30",
    });
    expect(result.helper).toBe(600000);
    const maxSafeSeconds = Math.floor(2_147_483_647 / 1000);
    expect(result.markReady).toBe(maxSafeSeconds);
    // The regression, stated directly: the unclamped sum would have
    // overflowed past the 32-bit ceiling instead of stopping at it.
    expect(4 * result.helper + 3 * result.gh + 7 * 2).toBeGreaterThan(
      maxSafeSeconds,
    );
  });
});

describe("driveStatusOnceTimeoutSeconds() outlives drive-status.ts --once's evidence chain", () => {
  const PROC = join(SCRIPTS, "lib", "proc.ts");

  function readTimeouts(env: Record<string, string>): {
    helper: number;
    gh: number;
    git: number;
    driveStatus: number;
  } {
    const dir = mkdtempSync(join(tmpdir(), "drive-status-timeout-"));
    writeFileSync(
      join(dir, "fixture.ts"),
      [
        `import { driveStatusOnceTimeoutSeconds, ghCallTimeoutSeconds, gitCallTimeoutSeconds, helperTimeoutSeconds } from ${JSON.stringify(PROC)};`,
        `process.stdout.write(JSON.stringify({ helper: helperTimeoutSeconds(), gh: ghCallTimeoutSeconds(), git: gitCallTimeoutSeconds(), driveStatus: driveStatusOnceTimeoutSeconds() }));`,
      ].join("\n"),
    );
    const out = execFileSync(process.execPath, [join(dir, "fixture.ts")], {
      cwd: dir,
      env: { ...gitCleanEnv(), ...env },
      encoding: "utf8",
      timeout: 15_000,
    });
    rmSync(dir, { recursive: true, force: true });
    return JSON.parse(out) as {
      helper: number;
      gh: number;
      git: number;
      driveStatus: number;
    };
  }

  it("tracks skewed helper, GitHub, and git budgets independently", () => {
    const result = readTimeouts({
      DRIVE_PR_HELPER_TIMEOUT: "900",
      GH_CALL_TIMEOUT: "30",
      GIT_CALL_TIMEOUT: "45",
    });
    expect(result.driveStatus).toBe(
      8 * result.helper + 12 * result.gh + 6 * result.git + 26 * 2,
    );
    expect(result.driveStatus).toBeGreaterThan(result.helper);
  });

  it("clamps the derived sum to the 32-bit-safe timer ceiling", () => {
    const result = readTimeouts({
      DRIVE_PR_HELPER_TIMEOUT: "600000",
      GH_CALL_TIMEOUT: "30",
      GIT_CALL_TIMEOUT: "30",
    });
    expect(result.driveStatus).toBe(Math.floor(2_147_483_647 / 1000));
  });
});

describe("finalVerifyTimeoutSeconds() outlives set-verified's own worst-case sequential GitHub-call chain (chatgpt-codex-connector, a reference-implementation pull request round 9)", () => {
  const PROC = join(SCRIPTS, "lib", "proc.ts");
  // The 15-call success chain, the CI policy's 2 sequential reads, and per
  // proof (3) the commit-status list plus up to MAX_STATUS_PUBLISHERS app
  // lookups. proc.ts mirrors that cap as a literal; reading it from
  // evidence.ts here makes a changed cap fail these assertions.
  const CALLS = 15 + 2 + 3 * (1 + MAX_STATUS_PUBLISHERS);

  function readTimeouts(env: Record<string, string>): {
    gh: number;
    finalVerify: number;
  } {
    const dir = mkdtempSync(join(tmpdir(), "drive-final-verify-timeout-"));
    writeFileSync(
      join(dir, "fixture.ts"),
      [
        `import { finalVerifyTimeoutSeconds, ghCallTimeoutSeconds } from ${JSON.stringify(PROC)};`,
        `process.stdout.write(JSON.stringify({ gh: ghCallTimeoutSeconds(), finalVerify: finalVerifyTimeoutSeconds() }));`,
      ].join("\n"),
    );
    const out = execFileSync(process.execPath, [join(dir, "fixture.ts")], {
      cwd: dir,
      env: { ...gitCleanEnv(), ...env },
      encoding: "utf8",
      timeout: 15_000,
    });
    rmSync(dir, { recursive: true, force: true });
    return JSON.parse(out) as { gh: number; finalVerify: number };
  }

  it("budgets the success path's 15 sequential GitHub calls, not a rounded estimate", () => {
    // set-verified's success path makes exactly 15 sequential `gh` calls:
    // the initial PR-view read (1) + the initial timeline read (1) + the
    // initial proveCiGreen() (3) + preWrite's stillFullyCurrent() (1 PR view
    // + 1 timeline + its own proveCiGreen()'s 3 = 5) + postWrite's
    // stillFullyCurrent() (another 5). A budget under that count lets the
    // parent kill the child after store.update() persists verifiedSha but
    // before the compensating post-write check can clear it.
    const result = readTimeouts({ GH_CALL_TIMEOUT: "30" });
    expect(result.finalVerify).toBe(900 + CALLS * result.gh + CALLS * 2);
  });

  it("budgets THREE lock acquisitions, not two (chatgpt-codex-connector, a reference-implementation pull request round 12)", () => {
    // The PR-wide remote-mutation lock, the state mutex for the certificate
    // write, and — on a stale post-write finding — a SECOND, independent
    // state-mutex acquisition for the compensating clear. Each can wait the
    // full LOCK_ACQUIRE_MAX_SEC (300s), so the lock budget alone must be
    // 3 * 300 = 900, not 600 (which covered only the first two). Asserted
    // directly against the 300s-per-lock constant rather than folded into
    // the total-seconds assertion above, so a future GH-call-count change
    // doesn't silently also have to know this number.
    const result = readTimeouts({ GH_CALL_TIMEOUT: "30" });
    const ghPortion = CALLS * result.gh + CALLS * 2;
    expect(result.finalVerify - ghPortion).toBe(3 * 300);
  });

  it("clamps the derived sum to the 32-bit-safe timer ceiling", () => {
    const result = readTimeouts({ GH_CALL_TIMEOUT: "600000" });
    expect(result.finalVerify).toBe(Math.floor(2_147_483_647 / 1000));
  });
});
