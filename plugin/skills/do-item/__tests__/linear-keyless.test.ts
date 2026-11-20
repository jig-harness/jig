/**
 * The `linear` client transport with no key: concurrent calls ask a client
 * whose credential is not known yet once, a client that says it has no API
 * key leaves the process refusing later calls for a while, and only the
 * client's own words, never an answer's data, say so.
 */
import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeProgram } from "../../../../lib/test-helpers/fake-program.ts";
import { OutboundError } from "../../../shared/outbound/failure.ts";
import { withLedgerWriter } from "../../../shared/outbound/ledger.ts";
import {
  forgetMissingCredentials,
  NOTE_HOLDS_MS,
} from "../../../shared/outbound/missing-credential.ts";
import { cliTransport } from "../scripts/lib/tracker/linear-transport.ts";

const roots: string[] = [];
afterEach(() => {
  setSystemTime();
  forgetMissingCredentials();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** A fake client that logs each call and answers as `body` says. */
function client(body: string): { bin: string; calls: () => number } {
  const root = mkdtempSync(join(tmpdir(), "linear-keyless-"));
  roots.push(root);
  const bin = join(root, "linear");
  const log = join(root, "calls.log");
  writeFakeProgram(
    bin,
    `#!/usr/bin/env bun
require("node:fs").appendFileSync(${JSON.stringify(log)}, "call\\n");
${body}
`,
  );
  return {
    bin,
    calls: () => {
      try {
        return readFileSync(log, "utf8").split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    },
  };
}

const LOGGED_OUT = `process.stderr.write("✗ API request failed: No API key configured\\n"); process.exit(1);`;

test("concurrent calls ask a logged-out client once, and every one fails as no credential", async () => {
  const fake = client(LOGGED_OUT);
  const transport = cliTransport(fake.bin);
  const results = await withLedgerWriter(
    () => undefined,
    () =>
      Promise.allSettled(
        ["query A { a }", "query B { b }", "query C { c }"].map((q) =>
          transport(q, {}),
        ),
      ),
  );
  expect(fake.calls()).toBe(1);
  for (const result of results) {
    expect(result.status).toBe("rejected");
    const error = (result as PromiseRejectedResult).reason;
    expect(error).toBeInstanceOf(OutboundError);
    expect((error as OutboundError).code).toBe("unauthorized");
    expect((error as OutboundError).failure.noCredential).toBe(true);
    expect((error as Error).message).toContain("No API key configured");
  }
});

test("a logged-in client is asked concurrently once its first answer came", async () => {
  const fake = client(`console.log(JSON.stringify({ data: { ok: true } }));`);
  const transport = cliTransport(fake.bin);
  await withLedgerWriter(
    () => undefined,
    async () => {
      await transport("query A { a }", {});
      await Promise.all([
        transport("query B { b }", {}),
        transport("query C { c }", {}),
      ]);
    },
  );
  expect(fake.calls()).toBe(3);
});

test("an answer's data that reads like the client's words does not mark the process keyless", async () => {
  const fake = client(
    `console.log(JSON.stringify({ errors: [{ message: "user is not logged in; No API key configured for this team" }] })); process.exit(1);`,
  );
  const transport = cliTransport(fake.bin);
  await withLedgerWriter(
    () => undefined,
    async () => {
      for (const q of ["query A { a }", "query B { b }"]) {
        const error = await transport(q, {}).catch((e: unknown) => e);
        expect((error as OutboundError).failure?.noCredential).toBeUndefined();
      }
    },
  );
  expect(fake.calls()).toBe(2);
});

test("the note holds for a while, then the client is asked again", async () => {
  const fake = client(LOGGED_OUT);
  const transport = cliTransport(fake.bin);
  const start = Date.parse("2026-11-20T12:00:00.000Z");
  setSystemTime(start);
  await withLedgerWriter(
    () => undefined,
    async () => {
      await transport("query A { a }", {}).catch(() => undefined);
      await transport("query B { b }", {}).catch(() => undefined);
      expect(fake.calls()).toBe(1);
      setSystemTime(start + NOTE_HOLDS_MS + 1);
      await transport("query C { c }", {}).catch(() => undefined);
    },
  );
  expect(fake.calls()).toBe(2);
});
