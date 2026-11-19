import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", drizzle: "src/drizzle.ts", prisma: "src/prisma.ts", convex: "src/convex.ts", testing: "src/testing.ts", agents: "src/agents.ts", eslint: "src/eslint.ts" },
  format: ["esm", "cjs"],
  dts: true,
  target: "node20",
  sourcemap: true,
  external: ["drizzle-orm", "convex", "kinde-testkit", "eslint"],
});
