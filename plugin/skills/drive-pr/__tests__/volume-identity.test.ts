/** Exercise the macOS utility contract in isolated children on every platform. */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { gitIdentityEnv } from "../scripts/lib/proc.ts";

const uuid = "12345678-1234-5678-9ABC-123456789ABC";
const df =
  "Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk10s3 100 10 90 10% /Volumes/With Spaces\n";
const plist = `<plist><dict><key>VolumeUUID</key><string>${uuid}</string></dict></plist>`;
function probe(answers: { code: number; stdout: string }[]) {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `
    import {mock} from "bun:test";
    Object.defineProperty(process,"platform",{value:"darwin"});
    const answers=${JSON.stringify(answers)}, calls=[];
    mock.module(${JSON.stringify(join(import.meta.dir, "../scripts/lib/proc.ts"))},()=>({run:async(argv,options)=>{calls.push({argv,options}); const result=answers.shift(); if(!result)throw new Error("unexpected utility call"); return result;}}));
    const {readVolumeIdentity}=await import(${JSON.stringify(join(import.meta.dir, "../scripts/lib/state/volume-identity.ts"))});
    const volume=await readVolumeIdentity("/Volumes/With Spaces/state");
    console.log(JSON.stringify({volume,calls}));
  `,
    ],
    { env: gitIdentityEnv(), stdout: "pipe", stderr: "pipe" },
  );
  expectSpawnExit(child, 0);
  return JSON.parse(child.stdout.toString()) as {
    volume: string | null;
    calls: { argv: string[]; options: { timeoutSec: number } }[];
  };
}

test("reads the directory's device, then its volume UUID, with bounded calls", () => {
  const result = probe([
    { code: 0, stdout: df },
    { code: 0, stdout: plist },
  ]);
  expect(result.volume).toBe(uuid.toLowerCase());
  expect(result.calls).toEqual([
    {
      argv: ["/bin/df", "-P", "/Volumes/With Spaces/state"],
      options: { timeoutSec: 2 },
    },
    {
      argv: ["/usr/sbin/diskutil", "info", "-plist", "/dev/disk10s3"],
      options: { timeoutSec: 2 },
    },
  ]);
});
for (const [name, answers] of [
  ["failed device lookup", [{ code: 1, stdout: df }]],
  [
    "unrecognized device",
    [{ code: 0, stdout: "server:/share 100 10 90 10% /mount" }],
  ],
  [
    "failed UUID lookup",
    [
      { code: 0, stdout: df },
      { code: 1, stdout: plist },
    ],
  ],
  [
    "missing UUID",
    [
      { code: 0, stdout: df },
      { code: 0, stdout: "<plist><dict/></plist>" },
    ],
  ],
  [
    "zero UUID",
    [
      { code: 0, stdout: df },
      {
        code: 0,
        stdout: plist.replace(uuid, "00000000-0000-0000-0000-000000000000"),
      },
    ],
  ],
  [
    "malformed UUID",
    [
      { code: 0, stdout: df },
      { code: 0, stdout: plist.replace(uuid, "not-an-identity") },
    ],
  ],
] as const) {
  test(`${name} supplies no proof for device drift`, () => {
    expect(probe([...answers]).volume).toBeNull();
  });
}
