import { expect, test } from "bun:test";
import { driverStopExitCode } from "../scripts/drive.ts";

test("a native Windows console break retains its own conventional exit status", () => {
  expect(driverStopExitCode("SIGBREAK")).toBe(149);
});

test("the neighboring signal and cooperative stop paths retain their statuses", () => {
  expect(driverStopExitCode("SIGHUP")).toBe(129);
  expect(driverStopExitCode("SIGINT")).toBe(130);
  expect(driverStopExitCode("SIGTERM")).toBe(143);
  expect(driverStopExitCode("stop request")).toBe(143);
});
