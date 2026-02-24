import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    reporters: ["verbose"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts", "packages/*/src/__tests__/**", "packages/*/src/index.ts"],
    },
  },
});
