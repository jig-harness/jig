import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PICKUP_MAX_BYTES,
  prunePickups,
  readPickup,
  renewPickup,
  withFileLock,
  writePickup,
} from "../scripts/lib/intent-chain-pickup.ts";

let dir: string;
const text = "<!-- refocus-arm: on -->\nOriginal batch scope.";
const file = (token: string) => join(dir, "pickups", `${token}.json`);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "intent-chain-pickup-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Construct independently hashed envelopes to isolate schema validation from
 * hash validation: malformed metadata must fail even with a matching hash.
 */
function envelope(value: unknown): string {
  const body = JSON.stringify(value);
  const token = createHash("sha256").update(body).digest("hex");
  mkdirSync(join(dir, "pickups"), { recursive: true });
  writeFileSync(file(token), body);
  return token;
}

describe("immutable pickup sources", () => {
  it("preserves original scope after aliases and the same session change", () => {
    const token = writePickup(dir, ["ENG-7", "ENG-8"], text);
    writeFileSync(join(dir, "ENG-8.md"), "Later solo scope.");
    writeFileSync(join(dir, "session.md"), "Later session scope.");
    const later = writePickup(
      dir,
      ["ENG-8"],
      "<!-- refocus-arm: off -->\nLater.",
    );
    expect(later).not.toBe(token);
    expect(readPickup(dir, token)).toEqual({
      identifiers: ["ENG-7", "ENG-8"],
      text,
    });
    expect(statSync(file(token)).mode & 0o777).toBe(0o600);
  });

  it("repeated identical writes reuse the inode and renew retention", () => {
    const token = writePickup(dir, ["ENG-8", "ENG-7", "ENG-7"], text);
    const inode = statSync(file(token)).ino;
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    utimesSync(file(token), old, old);
    expect(writePickup(dir, ["ENG-7", "ENG-8"], text)).toBe(token);
    expect(statSync(file(token)).ino).toBe(inode);
    prunePickups(dir);
    expect(existsSync(file(token))).toBe(true);
    expect(readdirSync(join(dir, "pickups"))).toEqual([`${token}.json`]);
  });

  it("refuses an expired source on read, though an identical rewrite revives it", () => {
    const token = writePickup(dir, ["ENG-7"], text);
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
    utimesSync(file(token), old, old);
    expect(() => readPickup(dir, token)).toThrow("expired");
    expect(readPickup(dir, token, { allowExpired: true }).text).toBe(text);
    expect(writePickup(dir, ["ENG-7"], text)).toBe(token);
    expect(readPickup(dir, token).text).toBe(text);
  });

  it("renewPickup restarts the retention window", () => {
    const token = writePickup(dir, ["ENG-7"], text);
    const old = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000);
    utimesSync(file(token), old, old);
    renewPickup(dir, token);
    expect(Date.now() - statSync(file(token)).mtimeMs).toBeLessThan(60_000);
  });

  it("expiry deletion is serialized with renewal under one lock", () => {
    const token = writePickup(dir, ["ENG-7"], text);
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    utimesSync(file(token), old, old);
    const lock = join(dir, "pickups", ".lock");
    writeFileSync(lock, "");
    // A held lock means prune cannot decide, so the expired source survives
    // and a renewal cannot proceed until the holder is done. Each gives up
    // after a 200ms wait instead of the production 2s.
    const priorWait = process.env.DO_ITEM_LOCK_WAIT_MS;
    process.env.DO_ITEM_LOCK_WAIT_MS = "200";
    try {
      prunePickups(dir);
      expect(existsSync(file(token))).toBe(true);
      expect(() => renewPickup(dir, token, { verify: true })).toThrow(
        "timed out waiting",
      );
    } finally {
      if (priorWait === undefined) delete process.env.DO_ITEM_LOCK_WAIT_MS;
      else process.env.DO_ITEM_LOCK_WAIT_MS = priorWait;
    }
    unlinkSync(lock);
    renewPickup(dir, token, { verify: true });
    prunePickups(dir);
    expect(existsSync(file(token))).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("withFileLock reclaims a lock left by a killed holder and releases its own", () => {
    const lock = join(dir, "x.lock");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 5 * 60 * 1000);
    utimesSync(lock, old, old);
    expect(withFileLock(lock, () => "ran")).toBe("ran");
    expect(existsSync(lock)).toBe(false);
  });

  it("withFileLock never releases a lock a successor now owns", () => {
    const lock = join(dir, "owned.lock");
    withFileLock(lock, () => {
      // Simulate reclamation by a rival while this holder is still running.
      unlinkSync(lock);
      writeFileSync(lock, "rival-token");
    });
    expect(readFileSync(lock, "utf8")).toBe("rival-token");
  });

  it("withFileLock restores a live lock it moved aside while reclaiming", () => {
    const lock = join(dir, "live.lock");
    writeFileSync(lock, "holder");
    // The contender's first age check (its second clock read, after the
    // deadline is set) sees a stale lock; by the time it judges the inode it
    // moved aside, that inode reads fresh, as when a rival replaced the lock
    // in between. The moved live lock must be linked back, not deleted.
    const realNow = Date.now.bind(Date);
    let reads = 0;
    const clock = spyOn(Date, "now").mockImplementation(() =>
      ++reads === 2 ? realNow() + 60 * 60 * 1000 : realNow(),
    );
    try {
      expect(() => withFileLock(lock, () => "ran", 30)).toThrow(/timed out/);
    } finally {
      clock.mockRestore();
    }
    expect(readFileSync(lock, "utf8")).toBe("holder");
    expect(readdirSync(dir).filter((n) => n.includes(".reclaim-"))).toEqual([]);
  });

  it("prune gives up after one failed lock wait instead of one per archive", () => {
    for (const id of ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"])
      writePickup(dir, [id], text);
    writeFileSync(join(dir, "pickups", ".lock"), "holder");
    const started = Date.now();
    prunePickups(dir);
    // One two-second wait for the pass; a wait per archive would take ten.
    expect(Date.now() - started).toBeLessThan(6000);
  });

  it("prunes abandoned publication temporaries but not recent ones", () => {
    writePickup(dir, ["ENG-7"], text);
    const abandoned = join(
      dir,
      "pickups",
      ".tmp-123-00000000-0000-4000-8000-000000000000",
    );
    const active = join(
      dir,
      "pickups",
      ".tmp-124-00000000-0000-4000-8000-000000000001",
    );
    writeFileSync(abandoned, "x");
    writeFileSync(active, "x");
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    utimesSync(abandoned, old, old);
    prunePickups(dir);
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(active)).toBe(true);
  });

  it("refuses corrupted content and does not overwrite an existing source", () => {
    const token = writePickup(dir, ["ENG-7"], text);
    writeFileSync(
      file(token),
      JSON.stringify({ identifiers: ["ENG-9"], text }),
    );
    expect(() => readPickup(dir, token)).toThrow("hash mismatch");
    expect(() => writePickup(dir, ["ENG-7"], text)).toThrow("hash mismatch");
    expect(readFileSync(file(token), "utf8")).toContain("ENG-9");
    expect(readdirSync(join(dir, "pickups"))).toEqual([`${token}.json`]);
  });

  it("refuses symlinks, directories, missing sources and traversal tokens", () => {
    const token = writePickup(dir, ["ENG-7"], text);
    const body = readFileSync(file(token));
    rmSync(file(token));
    const target = join(dir, "target.json");
    writeFileSync(target, body);
    symlinkSync(target, file(token));
    expect(() => readPickup(dir, token)).toThrow();
    expect(() => writePickup(dir, ["ENG-7"], text)).toThrow();
    rmSync(file(token));
    mkdirSync(file(token));
    expect(() => readPickup(dir, token)).toThrow("regular file");
    expect(() => readPickup(dir, "f".repeat(64))).toThrow();
    for (const invalid of [
      "../target",
      `${token}/../target`,
      token.toUpperCase(),
      "",
    ])
      expect(() => readPickup(dir, invalid)).toThrow("invalid pickup token");
  });

  it("refuses oversized sources and oversized writes", () => {
    const token = writePickup(dir, ["ENG-7"], text);
    writeFileSync(file(token), "x".repeat(PICKUP_MAX_BYTES + 1));
    expect(() => readPickup(dir, token)).toThrow("byte bound");
    expect(() =>
      writePickup(dir, ["ENG-7"], `${text}${"x".repeat(PICKUP_MAX_BYTES)}`),
    ).toThrow("byte bound");
  });

  it("refuses a FIFO without waiting for a writer", async () => {
    const token = "a".repeat(64);
    mkdirSync(join(dir, "pickups"));
    const made = Bun.spawnSync(["mkfifo", file(token)]);
    expect(made.exitCode, made.stderr.toString()).toBe(0);
    const helper = join(
      import.meta.dir,
      "../scripts/lib/intent-chain-pickup.ts",
    );
    const script = `import { readPickup } from ${JSON.stringify(helper)};
      try { readPickup(${JSON.stringify(dir)}, ${JSON.stringify(token)}); }
      catch (error) { console.error(error.message); process.exit(3); }`;
    const child = Bun.spawn([process.execPath, "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      const [exitCode, stderr, stdout] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
        new Response(child.stdout).text(),
      ]);
      expect(exitCode, `stdout: ${stdout}\nstderr: ${stderr}`).toBe(3);
      expect(stderr).toContain("not a regular file");
    } finally {
      clearTimeout(timer);
      child.kill();
    }
  });

  it("validates envelope ownership and the arm line even with a correct hash", () => {
    for (const value of [
      null,
      { identifiers: [], text },
      { identifiers: ["../ENG-7"], text },
      { identifiers: ["ENG-7", "ENG-7"], text },
      { identifiers: ["ENG-7"], text: 9 },
      { identifiers: ["ENG-7"], text, extra: true },
    ]) {
      const token = envelope(value);
      expect(() => readPickup(dir, token)).toThrow("pickup");
    }
    const token = envelope({ identifiers: ["ENG-7"], text: "No arm line." });
    expect(() => readPickup(dir, token)).toThrow("arm line");
    expect(() => writePickup(dir, ["ENG-7"], "No arm line.")).toThrow(
      "arm line",
    );
    expect(() => writePickup(dir, [], text)).toThrow("ownership");
  });

  it("prunes expired envelopes while retaining recent sources and unrelated files", () => {
    const stale = writePickup(dir, ["ENG-7"], text);
    const recent = writePickup(dir, ["ENG-8"], text);
    const now = Date.now();
    const old = new Date(now - 91 * 24 * 60 * 60 * 1000);
    utimesSync(file(stale), old, old);
    const unrelated = join(dir, "pickups", "notes.json");
    writeFileSync(unrelated, "keep");
    utimesSync(unrelated, old, old);
    const link = file("f".repeat(64));
    symlinkSync(file(recent), link);
    prunePickups(dir, now);
    expect(existsSync(file(stale))).toBe(false);
    expect(existsSync(file(recent))).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(link)).toBe(true);
    expect(() => prunePickups(join(dir, "missing"))).not.toThrow();
  });
});
