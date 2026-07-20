import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "tests/live/**"],
    testTimeout: 30000,
    hookTimeout: 10000,
  },
});
