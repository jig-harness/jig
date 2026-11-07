import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
  test: { include: [mode === "ci" ? "**/*.ci.ts" : "**/*.verify.ts"] },
}));
