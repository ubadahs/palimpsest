import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.ts"],
    // `*.fixture.ts` files are shared builders imported by tests.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/live/**",
      "tests/**/*.fixture.ts",
    ],
    testTimeout: 30000,
    hookTimeout: 10000,
  },
});
