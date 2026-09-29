import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    silent: "passed-only",
    name: "bb-plugin-pi-provider",
    include: ["*.test.ts", "*.test.tsx", "src/**/*.test.ts"],
    exclude: ["node_modules/**"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
