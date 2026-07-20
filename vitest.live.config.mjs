import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/live/**/*.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 600000,
    hookTimeout: 60000,
  },
});
