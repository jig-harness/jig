/**
 * Local fake-forge smoke of the installed plugin, with no POSIX shell dependency.
 * Normal gates run the native argv flow. The explicit Windows CI step selects
 * the PowerShell test and opts in with JIG_TEST_PWSH=1, requiring pwsh on PATH.
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expectSpawnExit } from "../../lib/test-helpers/expect-spawn-exit.ts";
import { writeFakeProgram } from "../../lib/test-helpers/fake-program.ts";
import { byPlatform } from "../../lib/test-helpers/windows-skip.ts";
import { writeWorkingArtifact } from "./artifact.ts";
import type { FixtureThread } from "../../plugin/skills/drive-pr/__tests__/drive-pr-harness.ts";

const repo = resolve(import.meta.dir, "../..");
const pwsh = Bun.which("pwsh");
const required = process.env.JIG_TEST_PWSH === "1";
function ownProcessGroup(): boolean {
  return (
    byPlatform(
      "POSIX cancellation stays inside the smoke driver's own process group; Windows cancels captured process identities",
      { windows: "identities", posix: "group" },
    ) === "group"
  );
}
const branch = "feature/SMOKE-999-native-shell";
const thread: FixtureThread = {
  id: "PRRT_smoke",
  path: "a.ts",
  bot: true,
  comments: [
    { author: "smoke-review[bot]", bot: true, body: "Please add a guard." },
  ],
};
const FAKE_GH = `#!/usr/bin/env bun
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const file=process.env.JIG_SMOKE_FORGE; const f=JSON.parse(readFileSync(file,'utf8')); const a=process.argv.slice(2); const value=(flag)=>a[a.indexOf(flag)+1];
appendFileSync(file+'.calls',JSON.stringify(a)+'\\n');
const output=(x)=>console.log(typeof x==='string'?x:JSON.stringify(x));
if(a[0]==='pr'&&a[1]==='create'){ if(!a.includes('--draft')) throw new Error('smoke PR must be draft'); f.created=true;writeFileSync(file,JSON.stringify(f));output('https://github.com/example-org/example-repo/pull/999');}
else if(a[0]==='repo'&&a[1]==='view'){ if(a.includes('-q')||a.includes('--jq'))output('example-org example-repo');else output({owner:{login:'example-org'},name:'example-repo'}); }
else if(a[0]==='pr'&&a[1]==='view'){
 if(!f.created)throw new Error('PR has not been opened');
 const p={number:999,state:'OPEN',isDraft:true,headRefOid:f.head,headRefName:f.branch,baseRefOid:f.head,baseRefName:'main',mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',title:'SMOKE-999: native shell',body:'Closes SMOKE-999',labels:[],url:'https://github.com/example-org/example-repo/pull/999',headRepositoryOwner:{login:'example-org'},headRepository:{name:'example-repo'}};
 const q=value('-q')??value('--jq'); if(q&&q.startsWith('.'))output(p[q.slice(1)]);else output(p);
}else if(a[0]==='api'){
 if(a.includes('graphql')){
 const t=f.thread;const node={id:t.id,isResolved:false,isOutdated:false,path:t.path,line:1,startLine:null,diffSide:'RIGHT',startDiffSide:null,comments:{pageInfo:{hasNextPage:false},nodes:t.comments.map(c=>({body:c.body,url:'https://github.com/example-org/example-repo/pull/999#discussion_r1',author:{login:c.author,__typename:'Bot'},authorAssociation:'NONE'}))}};
 output([{data:{repository:{pullRequest:{reviewThreads:{pageInfo:{hasNextPage:false,endCursor:null},nodes:[node]}}}}}]);
 }else{
 const endpoint=a.find(s=>s.startsWith('repos/')); if(!endpoint)throw new Error('unhandled endpoint '+JSON.stringify(a));
 let data;
 if(endpoint.includes('/pulls/999'))data={state:'open',head:{sha:f.head},base:{sha:f.head},draft:true};
 else if(endpoint.includes('/check-runs'))data={check_runs:[]};
 else if(endpoint.includes('/status'))data={statuses:[]};
 else if(endpoint.includes('/comments')&&a.includes('--input'))data={id:Date.now()};
 else if(endpoint.includes('/comments')||endpoint.includes('/reviews')||endpoint.includes('/timeline'))data=[];
 else throw new Error('unhandled endpoint '+endpoint);
 if(a.includes('--slurp'))data=[data];
 output((a.includes('--include')||a.includes('-i'))?'HTTP/2.0 200 OK\\r\\n\\r\\n'+JSON.stringify(data):data);
 }
}else throw new Error('unhandled gh call '+JSON.stringify(a));
`;

interface Fixture {
  root: string;
  consumer: string;
  bin: string;
  stateDir: string;
  skill: string;
  pickupSkill: string;
  shared: string;
  fakeData: string;
  passMarker: string;
  env: NodeJS.ProcessEnv;
  usePowerShell: boolean;
}
interface Driver {
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  output: Promise<[string, string]>;
}

function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !key.startsWith("GIT_") &&
        !key.startsWith("DRIVE_PR_") &&
        ![
          "CLAUDE_CODE_SESSION_ID",
          "CODEX_THREAD_ID",
          "GH_REPO",
          "JIG_CONFIG",
          "JIG_CONFIG_ROOT",
        ].includes(key),
    ),
  );
}

function fixtureEnvironment(
  root: string,
  consumer: string,
  bin: string,
  stateDir: string,
): NodeJS.ProcessEnv {
  const home = join(root, "home");
  return {
    ...cleanEnv(),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PATH: `${bin}${delimiter}${process.env.PATH}`,
    DRIVE_PR_STATE_DIR: stateDir,
    DRIVE_PR_HANDOFF_DIR: join(consumer, ".context"),
    DRIVE_PR_MAILBOX_DIR: join(root, "mailbox"),
    JIG_SMOKE_FORGE: join(root, "forge.json"),
    JIG_SMOKE_PASSES: join(root, "passes.json"),
    JIG_GH_CACHE: "0",
    DRIVE_PR_MAILBOX_POLL_MS: "50",
    DRIVE_PR_STALL_ROUNDS: "0",
    // The fake forge's PR has no head branch on a remote to attach.
    DRIVE_PR_ATTACH: "off",
    GH_CALL_TIMEOUT: "20",
    DRIVE_PR_HELPER_TIMEOUT: "60",
  };
}

function createFixture(usePowerShell: boolean): Fixture {
  if (usePowerShell && !pwsh)
    throw new Error("JIG_TEST_PWSH requires PowerShell (pwsh) on PATH");
  const root = mkdtempSync(join(tmpdir(), "jig native shell & "));
  const consumer = join(root, "consumer");
  const cache = join(root, "plugin cache");
  const bin = join(root, "bin");
  const stateDir = join(root, "drive state");
  for (const path of [consumer, bin, stateDir, join(root, "home")])
    mkdirSync(path, { recursive: true });
  writeWorkingArtifact(repo, cache);
  expect(existsSync(join(cache, "node_modules"))).toBe(false);
  expect(existsSync(join(cache, "plugin/node_modules"))).toBe(false);
  return {
    root,
    consumer,
    bin,
    stateDir,
    skill: join(cache, "plugin/skills/drive-pr"),
    pickupSkill: join(cache, "plugin/skills/do-item"),
    shared: join(cache, "plugin/shared/command.ts"),
    fakeData: join(root, "forge.json"),
    passMarker: join(root, "passes.json"),
    env: fixtureEnvironment(root, consumer, bin, stateDir),
    usePowerShell,
  };
}

function documented(path: string, match: (line: string) => boolean): string {
  const line = readFileSync(path, "utf8")
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s.startsWith("bun ") && match(s));
  if (!line) throw new Error(`documented smoke command missing in ${path}`);
  return line;
}

function expand(command: string, directory: string): string {
  return command.replaceAll(
    /\$\{CLAUDE_SKILL_DIR\}/g,
    directory.replaceAll("\\", "/"),
  );
}

function execute(fixture: Fixture, argv: string[], command?: string) {
  const fallback = `& ${argv.map((arg) => `'${arg.replaceAll("'", "''")}'`).join(" ")}`;
  const result = spawnSync(
    fixture.usePowerShell ? (pwsh ?? "pwsh") : (argv[0] ?? process.execPath),
    fixture.usePowerShell
      ? [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `${command ?? fallback}; exit $LASTEXITCODE`,
        ]
      : argv.slice(1),
    {
      cwd: fixture.consumer,
      env: fixture.env,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return { ...result, exitCode: result.status };
}

function bun(fixture: Fixture, argv: string[], command?: string) {
  return execute(fixture, [process.execPath, ...argv], command);
}

function git(fixture: Fixture, ...argv: string[]): string {
  const result = spawnSync("git", argv, {
    cwd: fixture.consumer,
    env: fixture.env,
    encoding: "utf8",
  });
  expectSpawnExit({ ...result, exitCode: result.status }, 0);
  return result.stdout.trim();
}

function seedConsumer(fixture: Fixture): void {
  const { consumer, bin, fakeData } = fixture;
  git(fixture, "init", "-q", "-b", branch);
  git(fixture, "config", "user.name", "Smoke Test");
  git(fixture, "config", "user.email", "smoke@example.invalid");
  git(
    fixture,
    "remote",
    "add",
    "origin",
    "https://github.com/example-org/example-repo.git",
  );
  mkdirSync(join(consumer, ".config"));
  mkdirSync(join(consumer, ".context"));
  writeFileSync(join(consumer, ".gitignore"), ".context/\n");
  writeFileSync(join(consumer, "a.ts"), "export const guarded = true;\n");
  writeFileSync(
    join(consumer, ".config/jig.yaml"),
    'repository:\n  base_branch: main\nreview:\n  bots: ["smoke-review[bot]"]\npull_requests:\n  mark_ready: never\nci:\n  required_checks: []\n',
  );
  git(fixture, "add", ".");
  git(fixture, "commit", "-qm", "chore: seed native shell smoke");
  const head = git(fixture, "rev-parse", "HEAD");
  writeFileSync(
    fakeData,
    JSON.stringify({ head, branch, thread, created: false }),
  );
  for (const forbidden of ["sh", "bash", "jq", "tail", "cat"])
    writeFakeProgram(
      join(bin, forbidden),
      "#!/usr/bin/env bun\nthrow new Error('POSIX command used by native shell smoke');\n",
    );
  writeFakeProgram(join(bin, "gh"), FAKE_GH);
}

function openDraft(fixture: Fixture): void {
  const { consumer, pickupSkill, shared } = fixture;
  writeFileSync(join(consumer, "body.md"), "Closes SMOKE-999\n");
  const command = expand(
    documented(join(pickupSkill, "SKILL.md"), (s) =>
      s.includes("-- gh pr create"),
    ),
    pickupSkill,
  )
    .replace("<createArgs...>", "--draft")
    .replace("<title in the planned convention>", "SMOKE-999: native shell")
    .replace("<body.md>", "body.md");
  expectSpawnExit(
    bun(
      fixture,
      [
        shared,
        "--",
        "gh",
        "pr",
        "create",
        "--draft",
        "--title",
        "SMOKE-999: native shell",
        "--body-file",
        "body.md",
      ],
      command,
    ),
    0,
  );
  rmSync(join(consumer, "body.md"));
}

function pickup(fixture: Fixture): string {
  const { consumer, pickupSkill } = fixture;
  writeFileSync(
    join(consumer, "intent-chain-input.json"),
    JSON.stringify({
      issue: {
        identifier: "SMOKE-999",
        title: "Native shell",
        description: "## Scope\nRun a bounded native shell smoke.",
      },
    }),
  );
  const command = expand(
    documented(
      join(pickupSkill, "SKILL.md"),
      (s) => s.includes("/scripts/intent-chain.ts") && s.includes("--input"),
    ),
    pickupSkill,
  );
  const result = bun(
    fixture,
    [
      join(pickupSkill, "scripts/intent-chain.ts"),
      "--input",
      "intent-chain-input.json",
    ],
    command,
  );
  expectSpawnExit(result, 0);
  const token = JSON.parse(result.stdout).pickupId as string;
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  rmSync(join(consumer, "intent-chain-input.json"));
  return token;
}

function capturePickup(fixture: Fixture, token: string): void {
  const { pickupSkill, skill } = fixture;
  const command = expand(
    documented(
      join(pickupSkill, "SKILL.md"),
      (s) => s.includes("/capture-intent-chain.ts") && s.includes("--pickup"),
    ),
    pickupSkill,
  )
    .replace("<PR>", "999")
    .replace("<pickupId>", token);
  const result = bun(
    fixture,
    [join(skill, "scripts/capture-intent-chain.ts"), "999", "--pickup", token],
    command,
  );
  expectSpawnExit(result, 0);
  expect(JSON.parse(result.stdout).kind).toBe("captured");
}

function recoverOrphan(fixture: Fixture): void {
  const orphan = join(fixture.root, "orphan's $decision & é.json");
  const recovered = join(fixture.root, "recovered's $decision & é.json");
  writeFileSync(orphan, "parked decisions");
  const emit = bun(fixture, [
    "-e",
    `const m=await import(${JSON.stringify(pathToFileURL(join(fixture.skill, "scripts/lib/state/orphans.ts")).href)});console.log(m.recoveryCommand(${JSON.stringify(orphan)},${JSON.stringify(recovered)}));`,
  ]);
  expectSpawnExit(emit, 0);
  const command = emit.stdout.trim();
  expectSpawnExit(
    bun(fixture, ["-e", command.slice('bun -e "'.length, -1)], command),
    0,
  );
  expect(existsSync(orphan)).toBe(false);
  expect(readFileSync(recovered, "utf8")).toBe("parked decisions");
}

function driverCommand(fixture: Fixture): { argv: string[]; command: string } {
  const pass = join(fixture.root, "pass-999.ts");
  writeFileSync(
    pass,
    `import {existsSync,readFileSync,writeFileSync} from 'node:fs';const file=process.env.JIG_SMOKE_PASSES!;const n=existsSync(file)?Number(readFileSync(file,'utf8'))+1:1;writeFileSync(file,String(n));if(n>1){setInterval(()=>{},1000);await new Promise(()=>{});}`,
  );
  const argv = [
    join(fixture.skill, "scripts/drive.ts"),
    "999",
    "--bots-only",
    "--keep-draft",
    "--handoff-at",
    "never",
    "--max-rounds",
    "4",
    "--",
    process.execPath,
    pass,
    "999",
    "--bots-only",
  ];
  const base = (
    expand(
      documented(
        join(fixture.skill, "SKILL.md"),
        (line) =>
          line.includes("/scripts/drive.ts") && line.includes(" -- claude -p "),
      ),
      fixture.skill,
    ).split(" -- ")[0] ?? ""
  ).replaceAll("123", "999");
  const command = `${base} --keep-draft --handoff-at never --max-rounds 4 -- bun "${pass.replaceAll("\\", "/")}" 999 --bots-only`;
  return { argv, command };
}

function startDriver(fixture: Fixture): Driver {
  const { argv, command } = driverCommand(fixture);
  const dry = bun(
    fixture,
    [join(fixture.skill, "scripts/drive.ts"), "--dry-run", ...argv.slice(1)],
    command.replace(" --keep-draft", " --dry-run --keep-draft"),
  );
  expectSpawnExit(dry, 0);
  expect(existsSync(fixture.passMarker)).toBe(false);
  const launch = fixture.usePowerShell
    ? [
        pwsh ?? "pwsh",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `${command}; exit $LASTEXITCODE`,
      ]
    : [process.execPath, ...argv];
  const child = Bun.spawn(launch, {
    cwd: fixture.consumer,
    env: fixture.env,
    detached: ownProcessGroup(),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  assertIsolatedDriver(child.pid);
  const output = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { process: child, output };
}

function assertIsolatedDriver(pid: number): void {
  if (!ownProcessGroup()) return;
  const group = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expectSpawnExit({ ...group, exitCode: group.status }, 0);
  expect(Number(group.stdout.trim())).toBe(pid);
}

function passesStarted(fixture: Fixture): number {
  return existsSync(fixture.passMarker)
    ? Number(readFileSync(fixture.passMarker, "utf8"))
    : 0;
}

function driverLogTail(fixture: Fixture): string {
  const log = join(fixture.stateDir, "drive-pr-999.log");
  return existsSync(log)
    ? readFileSync(log, "utf8").slice(-8000)
    : "driver log unavailable";
}

async function awaitSecondPass(
  fixture: Fixture,
  driver: Driver,
): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (
    passesStarted(fixture) < 2 &&
    Date.now() < deadline &&
    driver.process.exitCode === null
  )
    await Bun.sleep(50);
  if (passesStarted(fixture) >= 2) return;
  if (driver.process.exitCode !== null)
    throw new Error(
      `drive never completed a round: ${(await driver.output).join("\n")}`,
    );
  throw new Error(
    `drive did not start its second pass before the deadline (${passesStarted(fixture)} started)\n${driverLogTail(fixture)}`,
  );
}

async function awaitExit(driver: Driver, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (driver.process.exitCode === null && Date.now() < deadline)
    await Bun.sleep(50);
  if (driver.process.exitCode === null)
    throw new Error("driver did not exit before the deadline");
}

async function stopDriver(fixture: Fixture, driver: Driver): Promise<void> {
  const example = readFileSync(join(fixture.skill, "SKILL.md"), "utf8").match(
    /bun "\$\{CLAUDE_SKILL_DIR\}\/scripts\/drives\.ts" --stop <PR>/,
  )?.[0];
  if (!example) throw new Error("documented stop command missing");
  expectSpawnExit(
    bun(
      fixture,
      [join(fixture.skill, "scripts/drives.ts"), "--stop", "999"],
      expand(example, fixture.skill).replace("<PR>", "999"),
    ),
    0,
  );
  await awaitExit(driver, 20_000);
  const [stdout, stderr] = await driver.output;
  expectSpawnExit(
    { exitCode: await driver.process.exited, stdout, stderr },
    143,
    "stopped driver",
  );
  const listed = bun(fixture, [
    join(fixture.skill, "scripts/drives.ts"),
    "--json",
  ]);
  expectSpawnExit(listed, 0);
  const rows = JSON.parse(listed.stdout).rows as {
    kind: string;
    key: string;
    state: string;
  }[];
  expect(
    rows.filter(
      (row) => row.kind === "pr" && row.key === "999" && row.state === "live",
    ),
  ).toEqual([]);
  expect(readFileSync(`${fixture.fakeData}.calls`, "utf8")).toContain(
    "reviewThreads",
  );
}

async function cleanup(
  fixture: Fixture,
  driver: Driver | undefined,
): Promise<void> {
  if (driver && driver.process.exitCode === null) {
    driver.process.kill();
    await awaitExit(driver, 20_000);
  }
  rmSync(fixture.root, { recursive: true, force: true });
}

async function smoke(usePowerShell: boolean): Promise<void> {
  const fixture = createFixture(usePowerShell);
  let driver: Driver | undefined;
  try {
    seedConsumer(fixture);
    openDraft(fixture);
    capturePickup(fixture, pickup(fixture));
    recoverOrphan(fixture);
    driver = startDriver(fixture);
    await awaitSecondPass(fixture, driver);
    await stopDriver(fixture, driver);
  } finally {
    await cleanup(fixture, driver);
  }
}

test(
  "installed plugin picks up, opens a draft, captures, runs a round and stops with native argv",
  () => smoke(false),
  180_000,
);
test.skipIf(!required)(
  "documented pickup and drive workflow under PowerShell without Git Bash",
  () => smoke(true),
  180_000,
);
