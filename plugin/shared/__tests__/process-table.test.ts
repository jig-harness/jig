import { expect, test } from "bun:test";
import {
  parsePosixProcessTable,
  parseWindowsProcessTable,
  processTable,
} from "../process-table.ts";

test("POSIX snapshot preserves identity, group and command whitespace", () => {
  expect(
    parsePosixProcessTable(
      " 41 1 40 Mon Oct 19 12:34:56 2026 Sl bun /My Repo/pass.ts --prompt hello world\n",
    ),
  ).toEqual([
    {
      pid: 41,
      ppid: 1,
      pgid: 40,
      start: "Mon Oct 19 12:34:56 2026",
      stat: "Sl",
      args: "bun /My Repo/pass.ts --prompt hello world",
    },
  ]);
});

test("Windows snapshot accepts singleton and array with stable start identities", () => {
  const row = {
    ProcessId: 41,
    ParentProcessId: 1,
    CreationDate: "2026-10-19T12:34:56.1234567+00:00",
    CommandLine: '"C:\\Program Files\\bun.exe" C:\\Repo\\pass.ts',
  };
  const expected = [
    {
      pid: 41,
      ppid: 1,
      pgid: 0,
      start: row.CreationDate,
      stat: "R",
      args: row.CommandLine,
    },
  ];
  expect(parseWindowsProcessTable(JSON.stringify(row))).toEqual(expected);
  expect(parseWindowsProcessTable(JSON.stringify([row]))).toEqual(expected);
});

test("unreadable or incomplete snapshots cannot certify an empty tree", () => {
  for (const value of [
    "",
    "not-json",
    "null",
    "[]",
    '{"ProcessId":41,"ParentProcessId":1}',
  ]) {
    expect(parseWindowsProcessTable(value)).toBeNull();
  }
  expect(parsePosixProcessTable("unexpected output")).toBeNull();
});

test("Windows system processes allow null command lines but require identity", () => {
  expect(
    parseWindowsProcessTable(
      JSON.stringify([
        {
          ProcessId: 0,
          ParentProcessId: 0,
          CreationDate: "2026-10-19",
          CommandLine: null,
        },
      ]),
    ),
  ).toEqual([
    { pid: 0, ppid: 0, pgid: 0, start: "2026-10-19", stat: "R", args: "" },
  ]);
});

test("host snapshot includes this process with a usable identity", async () => {
  const rows = await processTable();
  const own = rows?.find((r) => r.pid === process.pid);
  expect(own?.start).toBeTruthy();
  expect(own?.ppid).toBe(process.ppid);
});

test("inaccessible identities preserve the pid without authorizing a kill", () => {
  expect(
    parseWindowsProcessTable(
      JSON.stringify({
        ProcessId: 4,
        ParentProcessId: 0,
        CreationDate: null,
        CommandLine: null,
      }),
    ),
  ).toEqual([{ pid: 4, ppid: 0, pgid: 0, start: "", stat: "R", args: "" }]);
});

test("Windows historical parent links never adopt children older than the current parent", () => {
  const rows = parseWindowsProcessTable(
    JSON.stringify([
      {
        ProcessId: 10,
        ParentProcessId: 1,
        CreationDate: "2026-10-19T12:00:00.0000000Z",
        CommandLine: "parent",
      },
      {
        ProcessId: 11,
        ParentProcessId: 10,
        CreationDate: "2026-10-19T11:00:00.0000000Z",
        CommandLine: "older unrelated child",
      },
      {
        ProcessId: 12,
        ParentProcessId: 10,
        CreationDate: "2026-10-19T12:00:00.0000000Z",
        CommandLine: "same instant child",
      },
      {
        ProcessId: 13,
        ParentProcessId: 10,
        CreationDate: null,
        CommandLine: null,
      },
    ]),
  );
  expect(rows?.find((r) => r.pid === 11)?.ppid).toBe(0);
  expect(rows?.find((r) => r.pid === 12)?.ppid).toBe(10);
  expect(rows?.find((r) => r.pid === 13)?.ppid).toBe(10);
});
