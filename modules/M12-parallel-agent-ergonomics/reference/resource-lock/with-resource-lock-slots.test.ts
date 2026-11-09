import { afterAll, expect, test } from "bun:test";
import {
  expectSpawnExit,
  expectSpawnExited,
} from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A lock is a symlink that names a pid, so it dangles: existsSync would follow it.
const exists = (path: string) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};
const scratch = mkdtempSync(join(tmpdir(), "jig-lock-slots-test-")),
  gate = join(import.meta.dir, "with-resource-lock.ts");
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
// A file, not `bun -e`, so Bun passes on `--exclusive` rather than reading it.
const wrapper = join(scratch, "probed-lock.ts");
// The lock with the host's reading replaced by PROBE: a HostLoad as JSON, or
// "throw" for a reading that fails.
const probed = `import {main} from ${JSON.stringify(gate)};
const probe = () => { if (process.env.PROBE === "throw") throw new Error("no reading"); return JSON.parse(process.env.PROBE); };
try { process.exitCode = await main(process.argv.slice(2), process.env, process.platform, probe); }
catch (error) { console.error("ERROR: " + error.message); process.exitCode = 2; }`;
// ERRLOG also gets every line the lock says, so a test can see a wait begin.
const probedWithLog = probed.replace(
  "const probe",
  `if (process.env.ERRLOG) { const say = console.error; console.error = (...a) => { require("node:fs").appendFileSync(process.env.ERRLOG, a.join(" ") + "\\n"); say(...a); }; }\nconst probe`,
);
writeFileSync(wrapper, probedWithLog);
const idle = JSON.stringify({ load1: 0, cores: 64, availableBytes: 2 ** 40 });
const busy = JSON.stringify({ load1: 100, cores: 4, availableBytes: 2 ** 40 });
const environment = (extra: Record<string, string>) => ({
  ...process.env,
  CI: "",
  RESOURCE_LOCK_BYPASS: "",
  LOCK_ROOT: scratch,
  LOCK_TIMEOUT: "10",
  LOCK_POLL: "0.02",
  LOCK_SLOTS: "",
  LOCK_STATIC_SLOTS: "",
  LOCK_RUN_COST: "",
  LOCK_TARGET_UTIL: "",
  LOCK_MIN_MEM_GB: "",
  ERRLOG: "",
  PROBE: idle,
  ...extra,
});
const spawn = (args: string[], env: Record<string, string>) =>
  Bun.spawn([process.execPath, wrapper, ...args], {
    env: environment(env),
    stdout: "pipe",
    stderr: "pipe",
  });
const run = async (args: string[], env: Record<string, string>) => {
  const proc = spawn(args, env);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};
const lockFile = (name: string) => join(scratch, `jig-lock.${name}`);
/** Hold `path` the way a holder publishes it, owned by this live process. */
const hold = (path: string) => {
  if (process.platform === "win32") writeFileSync(path, String(process.pid));
  else symlinkSync(String(process.pid), path);
};
const owner = (path: string) =>
  process.platform === "win32"
    ? readFileSync(path, "utf8")
    : readlinkSync(path);
/** The lock files `name` left behind: none once every holder has gone. */
const leftovers = (name: string) =>
  readdirSync(scratch).filter((file) => file.startsWith(`jig-lock.${name}`));
/** The most ENTER lines open at once in `log`. */
function widest(log: string): number {
  let inside = 0,
    most = 0;
  for (const line of log.trim().split("\n")) {
    if (line.startsWith("ENTER")) most = Math.max(most, ++inside);
    if (line.startsWith("EXIT")) inside--;
  }
  return most;
}
// Inside the lock: log ENTER, then stay until the GATE file exists, then log
// EXIT. The test opens the gate once the contender it watches has waited.
const barrier = `const fs=require('node:fs');fs.appendFileSync(process.env.LOG,'ENTER '+process.argv[1]+'\\n');const end=Date.now()+20000;while(Date.now()<end&&!fs.existsSync(process.env.GATE))await Bun.sleep(20);fs.appendFileSync(process.env.LOG,'EXIT '+process.argv[1]+'\\n');`;
const logged = (sleepMs: number) =>
  `const fs=require('node:fs');fs.appendFileSync(process.env.LOG,'ENTER '+process.argv[1]+'\\n');await Bun.sleep(${sleepMs});fs.appendFileSync(process.env.LOG,'EXIT '+process.argv[1]+'\\n');`;
/** Poll until `done` holds, failing past the deadline. */
async function until(done: () => boolean, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

test("runs up to the slot ceiling hold the lock at once, and one beyond waits for a free slot", async () => {
  const log = join(scratch, "ceiling.log"),
    gateFile = join(scratch, "ceiling.gate"),
    waits = join(scratch, "ceiling.waits");
  appendFileSync(log, "");
  appendFileSync(waits, "");
  const start = (id: string, extra: Record<string, string> = {}) =>
    spawn([process.execPath, "-e", barrier, id], {
      LOCK_NAME: "ceiling",
      LOCK_SLOTS: "2",
      LOCK_STATIC_SLOTS: "1",
      LOG: log,
      GATE: gateFile,
      ...extra,
    });
  const entered = () => readFileSync(log, "utf8").match(/ENTER/g)?.length ?? 0;
  const children = [start("A"), start("B")];
  await until(() => entered() === 2, "two runs inside the lock");
  children.push(start("C", { ERRLOG: waits }));
  await until(
    () => readFileSync(waits, "utf8").includes("waiting for 'ceiling'"),
    "the third run to wait",
  );
  expect(entered()).toBe(2);
  appendFileSync(gateFile, "");
  await Promise.all(
    children.map((c, i) => expectSpawnExited(c, 0, `child ${i}`)),
  );
  const text = readFileSync(log, "utf8");
  expect(text.match(/ENTER/g)?.length).toBe(3);
  expect(widest(text)).toBe(2);
  expect(leftovers("ceiling")).toEqual([]);
});

test("with the predicted load above the target a run waits beside free slots, naming the load and the holder", async () => {
  hold(lockFile("loaded"));
  try {
    const r = await run([process.execPath, "-e", ""], {
      LOCK_NAME: "loaded",
      LOCK_SLOTS: "4",
      LOCK_TIMEOUT: "1",
      PROBE: busy,
    });
    expectSpawnExit(r, 3);
    // The holder started just now, so its cost counts on top of the load.
    expect(r.stderr).toContain(
      "predicted load 104.0 + 4 for one more run exceeds 3.4",
    );
    expect(r.stderr).toContain(`pid ${process.pid}`);
    expect(exists(lockFile("loaded-slot-1"))).toBe(false);
  } finally {
    rmSync(lockFile("loaded"));
  }
  // The first run is admitted however loaded the host is.
  const first = await run([process.execPath, "-e", "console.log('ran')"], {
    LOCK_NAME: "loaded",
    LOCK_SLOTS: "4",
    LOCK_TIMEOUT: "0",
    PROBE: busy,
  });
  expectSpawnExit(first, 0);
  expect(first.stdout.trim()).toBe("ran");
});

test("a load reading that fails admits, so the slot ceiling decides", async () => {
  hold(lockFile("broken"));
  try {
    const r = await run(
      [
        process.execPath,
        "-e",
        `require('node:fs').lstatSync(${JSON.stringify(lockFile("broken-slot-1"))});console.log('slot 1 held')`,
      ],
      {
        LOCK_NAME: "broken",
        LOCK_SLOTS: "2",
        LOCK_TIMEOUT: "2",
        PROBE: "throw",
      },
    );
    expectSpawnExit(r, 0);
    expect(r.stdout.trim()).toBe("slot 1 held");
  } finally {
    rmSync(lockFile("broken"));
  }
  expect(leftovers("broken")).toEqual([]);
});

test("a lock an earlier version took under the lock's own name keeps slot 0, and the next run takes slot 1", async () => {
  hold(lockFile("earlier"));
  try {
    const r = await run(
      [
        process.execPath,
        "-e",
        `const fs=require('node:fs');console.log(['earlier','earlier-slot-1'].map(n=>{try{fs.lstatSync(${JSON.stringify(scratch)}+'/jig-lock.'+n);return n}catch{return '-'}}).join(' '))`,
      ],
      { LOCK_NAME: "earlier", LOCK_SLOTS: "4" },
    );
    expectSpawnExit(r, 0);
    expect(r.stdout.trim()).toBe("earlier earlier-slot-1");
    expect(owner(lockFile("earlier"))).toBe(String(process.pid));
    expect(exists(lockFile("earlier-slot-1"))).toBe(false);
  } finally {
    rmSync(lockFile("earlier"));
  }
});

test("a dead holder of a slot, of the admission lock or of an exclusive announcement is reclaimed, never wedging the queue", async () => {
  const dead = Bun.spawn([process.execPath, "-e", ""], {
    stdout: "ignore",
    stderr: "ignore",
  });
  await dead.exited;
  hold(lockFile("stale"));
  const leftover = (path: string) =>
    process.platform === "win32"
      ? writeFileSync(path, String(dead.pid))
      : symlinkSync(String(dead.pid), path);
  try {
    for (const file of ["stale.exclusive", "stale.admission", "stale-slot-1"])
      leftover(lockFile(file));
    const r = await run(
      [
        process.execPath,
        "-e",
        `require('node:fs').lstatSync(${JSON.stringify(lockFile("stale-slot-1"))});console.log('slot 1 held')`,
      ],
      { LOCK_NAME: "stale", LOCK_SLOTS: "2", LOCK_TIMEOUT: "5" },
    );
    expectSpawnExit(r, 0);
    expect(r.stdout.trim()).toBe("slot 1 held");
    expect(leftovers("stale")).toEqual(["jig-lock.stale"]);
  } finally {
    rmSync(lockFile("stale"));
    for (const file of ["stale.exclusive", "stale.admission", "stale-slot-1"])
      rmSync(lockFile(file), { force: true });
  }
});

test("an exclusive holder waits for every slot and, given up on, leaves none taken", async () => {
  hold(lockFile("gc-slot-3"));
  try {
    const r = await run(["--exclusive", "--", process.execPath, "-e", ""], {
      LOCK_NAME: "gc",
      LOCK_TIMEOUT: "0",
    });
    expectSpawnExit(r, 3);
    expect(r.stderr).toContain(
      `could not acquire lock 'gc' within 0s (held by pid ${process.pid}`,
    );
    expect(leftovers("gc")).toEqual(["jig-lock.gc-slot-3"]);
  } finally {
    rmSync(lockFile("gc-slot-3"));
  }
});

test("an exclusive holder holds every slot while it runs, and a run started meanwhile waits for it", async () => {
  const log = join(scratch, "exclusive.log"),
    inside = join(scratch, "exclusive.inside");
  appendFileSync(log, "");
  const collector = spawn(
    [
      "--exclusive",
      "--",
      process.execPath,
      "-e",
      `const fs=require('node:fs');fs.appendFileSync(process.env.LOG,'ENTER X\\n');fs.writeFileSync(${JSON.stringify(inside)}+'.part',['x','x-slot-63','x.exclusive'].map(n=>{try{fs.lstatSync(${JSON.stringify(scratch)}+'/jig-lock.'+n);return n}catch{return '-'}}).join(' '));fs.renameSync(${JSON.stringify(inside)}+'.part',${JSON.stringify(inside)});await Bun.sleep(800);fs.appendFileSync(process.env.LOG,'EXIT X\\n');`,
    ],
    { LOCK_NAME: "x", LOG: log },
  );
  await until(() => exists(inside), "the exclusive holder to start");
  expect(readFileSync(inside, "utf8")).toBe("x x-slot-63 x.exclusive");
  const suite = await run([process.execPath, "-e", logged(0), "S"], {
    LOCK_NAME: "x",
    LOG: log,
  });
  await expectSpawnExited(collector, 0, "exclusive holder");
  expectSpawnExit(suite, 0);
  expect(suite.stderr).toContain("an exclusive holder takes every slot");
  expect(readFileSync(log, "utf8")).toBe("ENTER X\nEXIT X\nENTER S\nEXIT S\n");
  expect(leftovers("x")).toEqual([]);
});

test("two exclusive holders take turns rather than deadlock", async () => {
  const log = join(scratch, "turns.log");
  appendFileSync(log, "");
  const children = ["A", "B"].map((id) =>
    spawn(["--exclusive", "--", process.execPath, "-e", logged(200), id], {
      LOCK_NAME: "turns",
      LOG: log,
    }),
  );
  await Promise.all(
    children.map((c, i) => expectSpawnExited(c, 0, `holder ${i}`)),
  );
  expect(widest(readFileSync(log, "utf8"))).toBe(1);
  expect(leftovers("turns")).toEqual([]);
});

for (const env of [
  { LOCK_SLOTS: "0" },
  { LOCK_SLOTS: "65" },
  { LOCK_SLOTS: "two" },
  { LOCK_STATIC_SLOTS: "yes" },
  { LOCK_TARGET_UTIL: "0" },
  { LOCK_TARGET_UTIL: "5" },
  { LOCK_RUN_COST: "-1" },
  { LOCK_MIN_MEM_GB: "lots" },
] as Record<string, string>[])
  test(`usage ${JSON.stringify(env)}`, async () =>
    expectSpawnExit(await run([process.execPath, "-e", ""], env), 2));
