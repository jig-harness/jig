import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.check.ts"],
    exclude: [...configDefaults.exclude, "src/legacy/**"],
  },
});
