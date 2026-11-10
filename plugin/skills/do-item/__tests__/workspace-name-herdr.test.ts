import { expect, test } from "bun:test";
import { nameConfig, renameWorkspace } from "../scripts/workspace-name.ts";

const request = {
  stage: "driving" as const,
  id: "#12",
  title: "Rename",
  pr: "42",
};

test("Herdr uses its session workspace even when Orca variables are inherited", async () => {
  const calls: string[][] = [];
  const result = await renameWorkspace(
    request,
    nameConfig({}),
    {
      HERDR_ENV: "1",
      HERDR_WORKSPACE_ID: "wA",
      ORCA_CLI_COMMAND: "orca",
    },
    async (command, args) => {
      calls.push([command, ...args]);
      return {
        code: 0,
        stdout: JSON.stringify({ result: { type: "workspace_renamed" } }),
        stderr: "",
      };
    },
  );
  expect(calls).toEqual([
    ["herdr", "workspace", "rename", "wA", "#12 [D] Rename #42"],
  ]);
  expect(result).toBe("workspace-name: #12 [D] Rename #42");
});

test("Herdr without its workspace id never renames the focused workspace", async () => {
  let calls = 0;
  const result = await renameWorkspace(
    request,
    nameConfig({}),
    { HERDR_ENV: "1" },
    async () => {
      calls++;
      return { code: 0, stdout: "", stderr: "" };
    },
  );
  expect(calls).toBe(0);
  expect(result).toContain("HERDR_WORKSPACE_ID");
});

test("a Herdr rename failure warns", async () => {
  const result = await renameWorkspace(
    request,
    nameConfig({}),
    { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "wA" },
    async () => ({ code: 1, stdout: "", stderr: "unavailable" }),
  );
  expect(result).toContain("⚠");
  expect(result).toContain("unavailable");
});

test("disabled names make no Herdr call", async () => {
  let called = false;
  await renameWorkspace(
    request,
    nameConfig({ workspace_name: { template: "" } }),
    { HERDR_ENV: "1", HERDR_WORKSPACE_ID: "wA" },
    async () => {
      called = true;
      return { code: 0, stdout: "", stderr: "" };
    },
  );
  expect(called).toBe(false);
});
