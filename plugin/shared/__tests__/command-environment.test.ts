import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";

const entry = resolve(import.meta.dir, "../command.ts");
const incomingParent =
  "00-11111111111111111111111111111111-2222222222222222-01";
const child =
  "console.log(JSON.stringify({enabled:process.env.JIG_TRACE,file:process.env.JIG_TRACE_FILE,parent:process.env.TRACEPARENT}))";

function probe(dir: string, args: string[]): Record<string, string> {
  const result = Bun.spawnSync(
    [process.execPath, entry, ...args, "--", "bun", "-e", child],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        JIG_TRACE: "1",
        JIG_TRACE_FILE: join(dir, "ambient.jsonl"),
        TRACEPARENT: incomingParent,
      },
    },
  );
  expectSpawnExit(result, 0);
  return JSON.parse(result.stdout.toString());
}

test("explicit trace environment edits survive ambient trace propagation", () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-command-environment-"));
  try {
    const file = join(dir, "explicit.jsonl");
    expect(probe(dir, ["--env", "JIG_TRACE_FILE", file]).file).toBe(file);
    expect(probe(dir, ["--env", "JIG_TRACE", "0"]).enabled).toBe("0");
    expect(probe(dir, ["--env", "TRACEPARENT", incomingParent]).parent).toBe(
      incomingParent,
    );
    expect(
      probe(dir, ["--unset-prefix", "JIG_", "--unset-prefix", "TRACE"]),
    ).toEqual({});
    const inherited = probe(dir, []);
    expect(inherited.file).toBe(join(dir, "ambient.jsonl"));
    expect(inherited.enabled).toBe("1");
    expect(inherited.parent).toMatch(
      /^00-11111111111111111111111111111111-[0-9a-f]{16}-01$/,
    );
    expect(inherited.parent).not.toBe(incomingParent);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
