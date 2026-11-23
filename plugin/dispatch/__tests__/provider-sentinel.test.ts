/** No record Jig writes holds a provider account's resolved credential, after a launch and after a refused resolution. */
import { expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  SENTINEL,
  type SentinelResult,
  SESSION,
} from "./provider-sentinel-child.ts";

/** Every file under `dir`, recursively. */
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

it.skipIf(process.platform === "win32")(
  "keeps the resolved value out of the launch records, the exit, the outcome log, the state database, the spool, the transcript copy and every reason",
  () => {
    const home = mkdtempSync(join(tmpdir(), "provider-sentinel-"));
    const scripts = mkdtempSync(join(tmpdir(), "provider-sentinel-scripts-"));
    const workspace = join(home, "workspace");
    mkdirSync(workspace);
    const credential = join(scripts, "credential.ts");
    writeFileSync(
      credential,
      `process.stdout.write(${JSON.stringify(`${SENTINEL}\n`)});\n`,
    );
    const failing = join(scripts, "failing.ts");
    writeFileSync(
      failing,
      `process.stdout.write(${JSON.stringify(SENTINEL)}); process.stderr.write(${JSON.stringify(`refused ${SENTINEL}\n`)}); process.exit(1);\n`,
    );
    const child = Bun.spawnSync(
      [
        process.execPath,
        resolve(import.meta.dir, "provider-sentinel-child.ts"),
        credential,
        failing,
        workspace,
        SESSION,
      ],
      { env: { ...process.env, HOME: home }, stderr: "pipe" },
    );
    expectSpawnExit(child, 0);
    const out: SentinelResult = JSON.parse(
      child.stdout.toString().trim().split("\n").at(-1) ?? "",
    );
    // The launch resolved the value and its pass carried it; the refused one started nothing.
    expect(out).toMatchObject({
      refusedStarted: false,
      started: true,
      carried: SENTINEL,
      provider: { provider: "openrouter", harness: "claude-code" },
      ended: 2,
      unlogged: [],
    });
    expect(out.said).toContain("<redacted>");
    expect(typeof out.copied).toBe("string");
    // The wrapper's refusal withholds the value its failing command printed.
    const refusal = child.stderr
      .toString()
      .split("\n")
      .find((line) => line.includes("nothing started"));
    expect(refusal).toContain("unauthorized: the credential command exited 1");
    expect(refusal).not.toContain(SENTINEL);
    const state = join(home, ".local", "state", "jig", "dispatch");
    const written = files(state).filter((path) => statSync(path).size > 0);
    // The records the grep reads are there: the state database, the wall, the spool, the transcript copy.
    expect(written.some((path) => path.endsWith("state.sqlite"))).toBe(true);
    expect(
      written.some((path) => path.includes(`${join(state, "walls")}`)),
    ).toBe(true);
    expect(written.some((path) => path.endsWith("transcript.jsonl"))).toBe(
      true,
    );
    const holding = written.filter((path) =>
      readFileSync(path).includes(Buffer.from(SENTINEL)),
    );
    expect(holding).toEqual([]);
  },
);
