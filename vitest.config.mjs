import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30000,
    hookTimeout: 10000,
  },
});
