/**
 * `lib/status/pr-snapshot.ts` — the status evaluation's conditional REST read
 * of the pull document, against a counted fake transport and a cache of its
 * own: what goes over the wire, when the kept reading is reused, and when it
 * is not.
 */

import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConditionalCache } from "../../../shared/gh-conditional.ts";
import type { RunResult } from "../../../shared/proc.ts";
import { readPrSnapshot } from "../scripts/lib/status/pr-snapshot.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const ETAG = '"pull-1"';

interface Wire {
  /** What the next answer is: a document, or a failure. */
  answer: "document" | "502" | "404" | "304-always" | "rate-limited";
  body: Record<string, unknown>;
  /** One line per request: `<status> <conditional|full>`. */
  sent: string[];
}

const root = mkdtempSync(join(tmpdir(), "pr-snapshot-"));
let seq = 0;
let wire: Wire;
let get: ReturnType<typeof createConditionalCache>["ghConditionalGet"];

afterAll(() => rmSync(root, { recursive: true, force: true }));

const base = {
  timedOut: false,
  bufferExceeded: false,
  spawnFailed: false,
  stderrTail: "",
};

function document(overrides: Record<string, unknown> = {}) {
  return {
    state: "open",
    merged: false,
    draft: false,
    head: { sha: HEAD, ref: "feature" },
    base: { sha: BASE, ref: "main" },
    mergeable: true,
    mergeable_state: "clean",
    ...overrides,
  };
}

async function transport(args: string[]): Promise<RunResult> {
  const conditional = args.includes(`If-None-Match: ${ETAG}`);
  const kind = conditional ? "conditional" : "full";
  if (wire.answer === "rate-limited") {
    wire.sent.push(`held ${kind}`);
    return {
      ...base,
      code: 1,
      stdout: "",
      stderr: "",
      held: { code: "rate-limited", reason: "the forge budget is spent" },
    };
  }
  if (wire.answer === "502") {
    wire.sent.push(`502 ${kind}`);
    return {
      ...base,
      code: 1,
      stdout: "HTTP/2.0 502 Bad Gateway\r\n\r\n",
      stderr: "gh: HTTP 502",
    };
  }
  if (wire.answer === "404") {
    wire.sent.push(`404 ${kind}`);
    return {
      ...base,
      code: 1,
      stdout: "HTTP/2.0 404 Not Found\r\n\r\n",
      stderr: "gh: Not Found (HTTP 404)",
    };
  }
  if (conditional || wire.answer === "304-always") {
    wire.sent.push(`304 ${kind}`);
    return {
      ...base,
      code: 1,
      stdout: `HTTP/2.0 304 Not Modified\r\nEtag: ${ETAG}\r\n\r\n`,
      stderr: "gh: HTTP 304",
    };
  }
  wire.sent.push(`200 ${kind}`);
  return {
    ...base,
    code: 0,
    stdout: `HTTP/2.0 200 OK\r\nEtag: ${ETAG}\r\n\r\n${JSON.stringify(wire.body)}`,
    stderr: "",
  };
}

beforeEach(() => {
  wire = { answer: "document", body: document(), sent: [] };
  const dir = join(root, `cache-${++seq}`);
  get = createConditionalCache({
    ghCall: (args) => transport(args),
    git: async (args) => ({
      ...base,
      code: args[0] === "remote" ? 0 : 1,
      stdout:
        args[0] === "remote"
          ? "origin\thttps://github.com/acme/widgets.git (fetch)\n"
          : "",
      stderr: "",
    }),
    cacheDir: () => dir,
  }).ghConditionalGet;
});

const read = () => readPrSnapshot("acme", "widgets", "7", "snapshot", get);

describe("readPrSnapshot", () => {
  it("reads an unchanged pull request once in full, then once conditionally answered 304", async () => {
    const first = await read();
    const second = await read();
    expect(wire.sent).toEqual(["200 full", "304 conditional"]);
    expect(second).toEqual(first);
    expect(first).toEqual({
      ok: true,
      snapshot: {
        state: "OPEN",
        isDraft: false,
        headRefOid: HEAD,
        headRefName: "feature",
        baseRefOid: BASE,
        baseRefName: "main",
        mergeable: "MERGEABLE",
        mergeStateStatus: "CLEAN",
      },
    });
  });

  it.each([
    [{ state: "closed", merged: true }, "state", "MERGED"],
    [{ state: "closed", merged: false }, "state", "CLOSED"],
    [{ state: "locked" }, "state", ""],
    [
      { mergeable: false, mergeable_state: "dirty" },
      "mergeable",
      "CONFLICTING",
    ],
    [{ mergeable: null, mergeable_state: "unknown" }, "mergeable", "UNKNOWN"],
    [{ mergeable: "yes" }, "mergeable", 'UNRECOGNISED "yes"'],
    [{ mergeable: "MERGEABLE" }, "mergeable", 'UNRECOGNISED "MERGEABLE"'],
    [{ mergeable_state: "blocked" }, "mergeStateStatus", "BLOCKED"],
    [{ draft: true }, "isDraft", true],
    [{ draft: null }, "isDraft", null],
  ] as const)(
    "maps %j to the evaluation's %s %j",
    async (overrides, field, want) => {
      wire.body = document(overrides);
      const r = await read();
      expect(r.ok && r.snapshot[field]).toBe(want);
    },
  );

  it("reads mergeability absent from the document as no mergeability, never as clean", async () => {
    const { mergeable: _, ...rest } = document();
    wire.body = rest;
    const r = await read();
    expect(r.ok && r.snapshot.mergeable).toBe("");
  });

  it("follows a failed conditional read with one full read, never taking it for unchanged", async () => {
    await read();
    wire.answer = "502";
    const r = await read();
    expect(r.ok).toBe(false);
    expect(wire.sent).toEqual(["200 full", "502 conditional", "502 full"]);
    // Both failures are named, not only the last one.
    expect(!r.ok && r.reason).toContain("then the full read");
  });

  it("names the conditional failure too when the full read answers something that is not a pull document", async () => {
    await read();
    const inner = get;
    let calls = 0;
    const html = async (...args: Parameters<typeof inner>) => {
      calls++;
      if (calls === 1) return inner(...args);
      return {
        ok: true as const,
        changed: true,
        body: "<html>proxy</html>",
      } as Awaited<ReturnType<typeof inner>>;
    };
    wire.answer = "502";
    const r = await readPrSnapshot("acme", "widgets", "7", "snapshot", html);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("then the full read");
    expect(!r.ok && r.reason).toContain("not a pull document");
    expect(!r.ok && r.reason).toContain("HTTP 502");
  });

  it("sends no second request for a pull request that is not there", async () => {
    await read();
    wire.answer = "404";
    const r = await read();
    expect(r.ok).toBe(false);
    expect(wire.sent).toEqual(["200 full", "404 conditional"]);
  });

  it("takes the full read's document when it answers after a failed conditional one", async () => {
    await read();
    wire.body = document({ head: { sha: "c".repeat(40), ref: "feature" } });
    let calls = 0;
    const flaky: typeof get = async (path, ctx) => {
      calls += 1;
      return calls === 1
        ? { ok: false, reason: "gh api: HTTP 502" }
        : get(path, ctx);
    };
    const r = await readPrSnapshot("acme", "widgets", "7", "snapshot", flaky);
    expect(r.ok && r.snapshot.headRefOid).toBe("c".repeat(40));
    expect(wire.sent).toEqual(["200 full", "200 full"]);
  });

  it("follows a 304 with no kept reading with a full read, and fails closed when that is a 304 too", async () => {
    wire.answer = "304-always";
    const r = await read();
    expect(r.ok).toBe(false);
    expect(wire.sent).toEqual(["304 full", "304 full"]);
  });

  it("follows a kept reading that is not a whole pull document with a full read", async () => {
    wire.body = { state: "open" };
    await read();
    wire.body = document();
    const r = await read();
    expect(r.ok && r.snapshot.headRefOid).toBe(HEAD);
    expect(wire.sent).toEqual(["200 full", "304 conditional", "200 full"]);
  });

  it("sends no second request when the shared budget held the first", async () => {
    wire.answer = "rate-limited";
    const r = await read();
    expect(r.ok).toBe(false);
    expect(wire.sent).toEqual(["held full"]);
  });

  it("refuses a pull request that is not a number without a request", async () => {
    const r = await readPrSnapshot(
      "acme",
      "widgets",
      "feature",
      "snapshot",
      get,
    );
    expect(r.ok).toBe(false);
    expect(wire.sent).toEqual([]);
  });

  it("sends no full read once the caller's budget is spent", async () => {
    wire.answer = "502";
    const r = await readPrSnapshot(
      "acme",
      "widgets",
      "7",
      "snapshot",
      get,
      () => 0,
    );
    expect(r.ok).toBe(false);
    expect(wire.sent).toEqual([]);
  });

  it("sends no full read after the first read spends the caller's budget", async () => {
    wire.answer = "502";
    const r = await readPrSnapshot(
      "acme",
      "widgets",
      "7",
      "snapshot",
      get,
      () => (wire.sent.length === 0 ? 5 : 0),
    );
    expect(r.ok).toBe(false);
    expect(wire.sent.length).toBe(1);
  });
});
