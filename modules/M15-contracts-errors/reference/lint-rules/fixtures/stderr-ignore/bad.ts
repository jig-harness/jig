// expect: 4
import { spawnSync } from "node:child_process";
export const a = spawnSync("git", ["status"], { stdio: "ignore" });
export const b = spawnSync("git", ["status"], {
  stdio: ["ignore", "pipe", "ignore"],
});
export const c = Bun.spawnSync(["git", "status"], { stdout: "pipe", stderr: "ignore" });
export const d = spawnSync("git", ["status"], {
  stdio: ["ignore", "pipe", "ignore", "ipc"],
});
