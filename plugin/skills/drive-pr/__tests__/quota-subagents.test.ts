import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

it("finds subagent walls only for the spawned session and shares the snapshot walk", async () => {
  const root = mkdtempSync(join(tmpdir(), "quota-subagents-"));
  const adapter = resolve("plugin/skills/drive-pr/scripts/lib/quota/claude.ts");
  const own = join(root, "project", "parent", "subagents", "agent-own.jsonl");
  const other = join(
    root,
    "project",
    "other",
    "subagents",
    "agent-other.jsonl",
  );
  const tooDeep = join(
    root,
    "project",
    "parent",
    "subagents",
    "nested",
    "deep.jsonl",
  );
  const wall = (sessionId: string) =>
    JSON.stringify({
      type: "assistant",
      cwd: root,
      sessionId,
      timestamp: "2026-08-20T12:30:00Z",
      error: "rate_limit",
      isApiErrorMessage: true,
      apiErrorStatus: 429,
      message: {
        content: [
          {
            type: "text",
            text: "You've hit your session limit · resets 3:20pm (Europe/Amsterdam)",
          },
        ],
      },
    });
  try {
    for (const [path, id] of [
      [own, "ours"],
      [other, "theirs"],
      [tooDeep, "deep"],
    ] as const) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${wall(id)}\n`);
    }
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import { claudeAdapter as a } from ${JSON.stringify(adapter)};
      const opts = { cwd: ${JSON.stringify(root)}, since: Temporal.Instant.from('2026-08-20T12:00:00Z'), now: Temporal.Instant.from('2026-08-20T12:35:00Z') };
      console.log(JSON.stringify({ snapshot: a.snapshotSessions(), own: a.detect({...opts, correlation: {vendor:'claude',sessionId:'ours'}}), other: a.detect({...opts, correlation: {vendor:'claude',sessionId:'absent'}}) }));
    `,
      ],
      {
        env: { ...process.env, DRIVE_PR_CLAUDE_PROJECTS_DIR: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expectSpawnExit({ exitCode: await child.exited, stdout, stderr }, 0);
    const result = JSON.parse(stdout);
    expect(result.snapshot.truncated).toBe(false);
    expect(result.snapshot.files.sort()).toEqual([own, other].sort());
    expect(result.own?.window).toBe("short");
    expect(result.other).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("shares the candidate entry cap across nested subagent directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "quota-subagent-cap-"));
  const adapter = resolve("plugin/skills/drive-pr/scripts/lib/quota/claude.ts");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import {mkdirSync,writeFileSync} from 'node:fs';
      import {join} from 'node:path';
      import {claudeAdapter as a} from ${JSON.stringify(adapter)};
      import {MAX_CANDIDATE_FILES_SCANNED as cap} from ${JSON.stringify(resolve("plugin/skills/drive-pr/scripts/lib/quota/types.ts"))};
      const root=${JSON.stringify(root)};
      for(const session of ['one','two']) {
        const dir=join(root,'project',session,'subagents');
        mkdirSync(dir,{recursive:true});
        for(let i=0;i<Math.ceil(cap/2);i++)writeFileSync(join(dir,i+'.txt'),'');
      }
      console.log(JSON.stringify(a.snapshotSessions()));
    `,
      ],
      {
        env: {
          ...process.env,
          DRIVE_PR_CLAUDE_PROJECTS_DIR: root,
          DRIVE_PR_QUOTA_MAX_SCAN_MS: "60000",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expectSpawnExit({ exitCode: await child.exited, stdout, stderr }, 0);
    expect(JSON.parse(stdout).truncated).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("continues sibling enumeration after a transcript stat failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "quota-stat-failure-"));
  const adapter = resolve("plugin/skills/drive-pr/scripts/lib/quota/claude.ts");
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
      import {mkdirSync,writeFileSync,readdirSync,unlinkSync,symlinkSync} from 'node:fs';
      import {join} from 'node:path';
      import {claudeAdapter as a} from ${JSON.stringify(adapter)};
      const dir=join(${JSON.stringify(root)},'project');
      mkdirSync(dir);
      for(const name of ['a.jsonl','b.jsonl'])writeFileSync(join(dir,name),'');
      const [bad,good]=readdirSync(dir);
      unlinkSync(join(dir,bad));
      symlinkSync(bad,join(dir,bad));
      const snapshot=a.snapshotSessions();
      console.log(JSON.stringify({truncated:snapshot.truncated,found:snapshot.files.includes(join(dir,good))}));
    `,
      ],
      {
        env: { ...process.env, DRIVE_PR_CLAUDE_PROJECTS_DIR: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    expectSpawnExit({ exitCode: await child.exited, stdout, stderr }, 0);
    expect(JSON.parse(stdout)).toEqual({ truncated: true, found: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
