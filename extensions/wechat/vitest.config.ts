import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    // Don't use root setupFiles - extension tests are standalone
  },
});
