import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";

// Unit tests are plain Node by default; files that need a DOM opt in with a
// `// @vitest-environment jsdom` docblock on their first line.
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
