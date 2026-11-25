import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "workers/*/test/**/*.test.ts", "eval/test/**/*.test.ts", "sdks/*/test/**/*.test.ts"],
    testTimeout: 60_000,
  },
});
