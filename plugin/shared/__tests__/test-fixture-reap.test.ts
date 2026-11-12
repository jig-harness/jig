import { expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  captureIdentity,
  encodeIdentity,
  ownIdentity,
  type ProcessIdentity,
} from "../liveness.ts";
import type { ProcessRow } from "../process-table.ts";
import { orphanFixtureProof, reapFixtureScope } from "../test-fixture-reap.ts";

const identity = (pid: number, start = "fixture-start"): ProcessIdentity => ({
  ...ownIdentity(),
  pid,
  start,
});
const row = (who: ProcessIdentity): ProcessRow => ({
  pid: who.pid,
  start: who.start,
  ppid: 0,
  pgid: who.pid,
  stat: "S",
  args: "fixture",
});
function fixture(owner = identity(500_000_000), child = identity(500_000_001)) {
  const directory = mkdtempSync(join(tmpdir(), "fixture-reap-"));
  const root = join(directory, "scratch");
  const registry = join(directory, "registry");
  const nodes = join(registry, "nodes");
  mkdirSync(root);
  mkdirSync(registry);
  mkdirSync(nodes);
  const ownerNode = randomUUID();
  const childNode = randomUUID();
  const scopeName = `scope-${createHash("sha256").update(resolve(root)).digest("hex")}.json`;
  writeFileSync(
    join(registry, scopeName),
    JSON.stringify({ version: 1, root, createdAt: new Date().toISOString() }),
  );
  for (const [node, parent, who] of [
    [ownerNode, null, owner],
    [childNode, ownerNode, child],
  ] as const)
    writeFileSync(
      join(nodes, `${node}.json`),
      JSON.stringify({
        version: 1,
        state: "registered",
        parent,
        identity: encodeIdentity(who),
      }),
    );
  writeFileSync(join(nodes, `${childNode}.claim`), encodeIdentity(child), {
    flag: "wx",
    mode: 0o600,
  });
  return {
    root,
    registry,
    owner,
    child,
    childNode,
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("an exited owner permits killing its registered orphan and witnesses its disappearance", async () => {
  const f = fixture();
  const killed: number[] = [];
  try {
    const proof = await reapFixtureScope(f.root, f.registry, {
      table: async () => (killed.length ? [] : [row(f.child)]),
      kill: (pid) => {
        killed.push(pid);
      },
    });
    expect(proof.state).toBe("dead");
    expect(killed).toEqual([f.child.pid]);
  } finally {
    f.dispose();
  }
});

test("a live owner prevents every signal", async () => {
  const f = fixture();
  const killed: number[] = [];
  try {
    const proof = await reapFixtureScope(f.root, f.registry, {
      table: async () => [row(f.owner), row(f.child)],
      kill: (pid) => {
        killed.push(pid);
      },
    });
    expect(proof.state).toBe("live");
    expect(killed).toEqual([]);
  } finally {
    f.dispose();
  }
});

test("pending or opaque launches prevent every signal", async () => {
  for (const state of ["pending", "opaque"]) {
    const f = fixture();
    const killed: number[] = [];
    try {
      writeFileSync(
        join(f.registry, "nodes", `${randomUUID()}.json`),
        JSON.stringify({ version: 1, state, parent: f.childNode }),
      );
      const proof = await reapFixtureScope(f.root, f.registry, {
        table: async () => [row(f.child)],
        kill: (pid) => {
          killed.push(pid);
        },
      });
      expect(proof.state).toBe("unverified");
      expect(killed).toEqual([]);
    } finally {
      f.dispose();
    }
  }
});

test("foreign identities and unreadable process tables prevent every signal", async () => {
  for (const foreign of [false, true]) {
    const f = fixture(identity(500_000_000), {
      ...identity(500_000_001),
      ...(foreign ? { hostId: "other-machine" } : {}),
    });
    const killed: number[] = [];
    try {
      const proof = await reapFixtureScope(f.root, f.registry, {
        table: async () => (foreign ? [row(f.child)] : null),
        kill: (pid) => {
          killed.push(pid);
        },
      });
      expect(proof.state).toBe("unverified");
      expect(killed).toEqual([]);
    } finally {
      f.dispose();
    }
  }
});

test("a reused child pid is never signalled", async () => {
  const f = fixture();
  const killed: number[] = [];
  let reads = 0;
  try {
    const proof = await reapFixtureScope(f.root, f.registry, {
      table: async () => [
        row({ ...f.child, start: ++reads > 1 ? "replacement" : f.child.start }),
      ],
      kill: (pid) => {
        killed.push(pid);
      },
    });
    expect(proof.state).toBe("dead");
    expect(killed).toEqual([]);
  } finally {
    f.dispose();
  }
});

test("a killer success cannot substitute for a disappearance witness", async () => {
  const f = fixture();
  let clock = 0;
  try {
    const proof = await reapFixtureScope(f.root, f.registry, {
      table: async () => [row(f.child)],
      kill: () => {
        // A successful signal request alone must not prove disappearance.
      },
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
      timeoutMs: 10,
    });
    expect(proof.state).toBe("unverified");
  } finally {
    f.dispose();
  }
});

test("a real registered process is reaped after its recorded owner exited", async () => {
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {},1000)"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
  );
  let f: ReturnType<typeof fixture> | undefined;
  try {
    const captured = await captureIdentity(child.pid);
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    f = fixture(identity(500_000_000), captured.value);
    expect((await orphanFixtureProof(f.root, f.registry)).state).toBe("dead");
    expect((await reapFixtureScope(f.root, f.registry)).state).toBe("dead");
    await child.exited;
  } finally {
    child.kill();
    await child.exited;
    f?.dispose();
  }
}, 20_000);

test("reaping never signals a registry whose owner is this test process", async () => {
  const f = fixture(ownIdentity());
  try {
    expect((await orphanFixtureProof(f.root, f.registry)).state).toBe("live");
  } finally {
    f.dispose();
  }
});

test("a collector registered in the fixture tree cannot reap itself", async () => {
  const f = fixture(identity(500_000_000), ownIdentity());
  const killed: number[] = [];
  let clock = 0;
  try {
    const proof = await reapFixtureScope(f.root, f.registry, {
      table: async () => [row(f.child)],
      kill: (pid) => {
        killed.push(pid);
      },
      timeoutMs: 10,
      now: () => clock,
      pause: async (ms) => {
        clock += ms;
      },
    });
    expect(proof.state).toBe("live");
    expect(killed).toEqual([]);
  } finally {
    f.dispose();
  }
});
