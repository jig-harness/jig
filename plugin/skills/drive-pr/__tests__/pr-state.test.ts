/**
 * `lib/pr-state.ts` — the state-ONLY liveness read that
 * drive-status's sweep probe and evaluate's closedSinceOpen recheck share.
 *
 * A numeric PR goes over `readPrLiveness`'s conditional REST (no GraphQL); a
 * URL or branch has no REST path and is answered by `gh pr view`. Both fail
 * CLOSED: an unreadable, unparseable or unrecognised answer is `ok: false`,
 * never a guessed state — the callers turn that into INDETERMINATE.
 *
 * Against a stub `gh` that logs every invocation to `calls.log`, so a test
 * reads off what actually went over the wire (GraphQL `pr view` vs REST
 * `api -i`) instead of inferring it. The cache is forced off
 * (`JIG_GH_CACHE=off`, which beats an inherited `JIG_GH_CACHE_DIR`)
 * so nothing here can be answered from a neighbour's entry — except the one
 * test that points it at its own fresh directory to exercise revalidation.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { readPrState } from "../scripts/lib/pr-state.ts";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";

const STUB = `#!/usr/bin/env bash
D="\${GH_STUB_DIR:?GH_STUB_DIR not set}"
echo "$*" >> "$D/calls.log"
[ -f "$D/hang" ] && sleep "$(cat "$D/hang")"
if [ "$1 $2" = 'api -i' ]; then
  if [ -f "$D/rest-fail" ]; then
    printf 'HTTP/2.0 502 Bad Gateway\\r\\n\\r\\n'
    echo 'gh: HTTP 502' >&2
    exit 1
  fi
  etag=""
  [ -f "$D/etag" ] && etag="$(cat "$D/etag")"
  if [ -n "$etag" ] && [[ " $* " == *"If-None-Match: $etag "* ]]; then
    printf 'HTTP/2.0 304 Not Modified\\r\\nEtag: %s\\r\\n\\r\\n' "$etag"
    echo 'gh: HTTP 304' >&2
    exit 1
  fi
  printf 'HTTP/2.0 200 OK\\r\\nContent-Type: application/json\\r\\n'
  [ -n "$etag" ] && printf 'Etag: %s\\r\\n' "$etag"
  printf '\\r\\n'
  cat "$D/rest-body"
  exit 0
fi
if [ "$1 $2" = 'pr view' ]; then
  [ -f "$D/view-fail" ] && { echo 'gh: pr view failed' >&2; exit 1; }
  # Model gh faithfully: with the jq filter the scalar state is printed; without
  # it gh emits the JSON object, which the helper must NOT accept as a state.
  if [[ " $* " == *' -q .state '* ]]; then
    cat "$D/view-state"
  else
    printf '{"state":"%s"}\\n' "$(tr -d '\\n' < "$D/view-state")"
  fi
  exit 0
fi
echo "gh-stub: unhandled: $*" >&2
exit 2
`;

let tmpRoot: string;
let binDir: string;
let fixDir: string;
let seq = 0;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "PATH",
  "GH_STUB_DIR",
  "GH_CALL_TIMEOUT",
  "GH_REPO",
  "JIG_GH_CACHE",
  "JIG_GH_CACHE_DIR",
];

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "pr-state-"));
  binDir = join(tmpRoot, "bin");
  mkdirSync(binDir);
  writeFakeProgram(join(binDir, "gh"), STUB);
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  fixDir = join(tmpRoot, `fix-${++seq}`);
  mkdirSync(fixDir);
  process.env.PATH = `${binDir}${delimiter}${savedEnv.PATH}`;
  process.env.GH_STUB_DIR = fixDir;
  process.env.GH_CALL_TIMEOUT = "20";
  // Off beats an inherited JIG_GH_CACHE_DIR, which itself beats NODE_ENV=test.
  process.env.JIG_GH_CACHE = "off";
  delete process.env.JIG_GH_CACHE_DIR;
  delete process.env.GH_REPO;
});

const restBody = (state: string, merged = false) =>
  writeFileSync(
    join(fixDir, "rest-body"),
    JSON.stringify({ state, merged, head: { sha: "a".repeat(40) } }),
  );

const calls = (): string[] =>
  existsSync(join(fixDir, "calls.log"))
    ? readFileSync(join(fixDir, "calls.log"), "utf8")
        .split("\n")
        .filter(Boolean)
    : [];

describe("readPrState — a numeric PR", () => {
  it.each([
    ["open", false, "OPEN"],
    ["closed", false, "CLOSED"],
    ["closed", true, "MERGED"],
  ] as const)(
    "maps REST %s (merged=%s) to %s without a GraphQL call",
    async (state, merged, want) => {
      restBody(state, merged);
      expect(await readPrState("7")).toEqual({ ok: true, state: want });
      const seen = calls();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("api -i");
      expect(seen[0]).toContain("pulls/7");
      expect(seen.some((c) => c.startsWith("pr view"))).toBe(false);
    },
  );

  it("revalidates a second read with If-None-Match and takes the state from the cached body on 304", async () => {
    process.env.JIG_GH_CACHE_DIR = join(fixDir, "cache");
    delete process.env.JIG_GH_CACHE;
    // Identifies the repository even in a remote-less checkout.
    process.env.GH_REPO = "acme/widgets";
    restBody("closed", true);
    writeFileSync(join(fixDir, "etag"), "etag-1");
    expect(await readPrState("7")).toEqual({ ok: true, state: "MERGED" });
    expect(await readPrState("7")).toEqual({ ok: true, state: "MERGED" });
    const api = calls().filter((c) => c.startsWith("api -i"));
    expect(api).toHaveLength(2);
    expect(api[0]).not.toContain("If-None-Match");
    expect(api[1]).toContain("If-None-Match: etag-1");
    expect(calls().some((c) => c.startsWith("pr view"))).toBe(false);
  });

  it("fails closed on merged=true with no readable state", async () => {
    writeFileSync(
      join(fixDir, "rest-body"),
      JSON.stringify({ merged: true, head: { sha: "a".repeat(40) } }),
    );
    expect((await readPrState("7")).ok).toBe(false);
  });

  it("fails closed on a REST failure — and does NOT fall back to GraphQL", async () => {
    writeFileSync(join(fixDir, "rest-fail"), "");
    const r = await readPrState("7");
    expect(r.ok).toBe(false);
    // A silent fallback would hide a broken REST path behind the very GraphQL
    // spend this read exists to avoid.
    expect(calls().some((c) => c.startsWith("pr view"))).toBe(false);
  });

  it("lets merged win over state, so a merged PR is never reported as merely closed or open", async () => {
    restBody("open", true);
    expect(await readPrState("7")).toEqual({ ok: true, state: "MERGED" });
  });

  it("fails closed on a body that is not JSON", async () => {
    writeFileSync(join(fixDir, "rest-body"), "not json");
    expect((await readPrState("7")).ok).toBe(false);
  });

  it("fails closed on a state it does not recognise instead of guessing", async () => {
    restBody("locked");
    expect((await readPrState("7")).ok).toBe(false);
  });

  it("is bounded by the caller's budget, not the 20s default", async () => {
    restBody("open");
    writeFileSync(join(fixDir, "hang"), "15");
    const t0 = Date.now();
    const r = await readPrState("7", { timeoutSec: 1 });
    expect(r.ok).toBe(false);
    // Well under the 5s a mis-applied fixed deadline would take, so the
    // caller's one second — not some larger default — is what ended the read.
    expect(Date.now() - t0).toBeLessThan(3500);
  }, 20_000);
});

describe("readPrState — a URL or branch (no REST path)", () => {
  it.each(["OPEN", "CLOSED", "MERGED"] as const)(
    "reads %s through gh pr view",
    async (state) => {
      writeFileSync(join(fixDir, "view-state"), `${state}\n`);
      expect(await readPrState("feature/x")).toEqual({ ok: true, state });
      const seen = calls();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toBe("pr view feature/x --json state -q .state");
    },
  );

  it("fails closed on an unrecognised state", async () => {
    writeFileSync(join(fixDir, "view-state"), "DRAFTED\n");
    const r = await readPrState("https://github.com/acme/widgets/pull/7");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("unrecognised state 'DRAFTED'");
  });

  it("fails closed when gh exits non-zero", async () => {
    writeFileSync(join(fixDir, "view-fail"), "");
    expect((await readPrState("feature/x")).ok).toBe(false);
  });

  it("bounds the fallback by the caller's budget too", async () => {
    writeFileSync(join(fixDir, "view-state"), "OPEN\n");
    writeFileSync(join(fixDir, "hang"), "15");
    const t0 = Date.now();
    const r = await readPrState("feature/x", { timeoutSec: 1 });
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3500);
  }, 20_000);

  it("starts no fallback call once the caller budget is spent", async () => {
    writeFileSync(join(fixDir, "view-state"), "OPEN\n");
    const r = await readPrState("feature/x", { timeoutSec: 0 });
    expect(r.ok).toBe(false);
    expect(calls()).toHaveLength(0);
  });

  it("fails closed on empty output", async () => {
    writeFileSync(join(fixDir, "view-state"), "");
    expect((await readPrState("feature/x")).ok).toBe(false);
  });
});
