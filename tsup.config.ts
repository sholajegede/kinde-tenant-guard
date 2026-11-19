import { defineConfig } from "tsup";

const external = ["drizzle-orm", "convex", "kinde-testkit", "eslint", "@babel/parser", "pg"];

export default defineConfig([
  {
    entry: { index: "src/index.ts", drizzle: "src/drizzle.ts", prisma: "src/prisma.ts", convex: "src/convex.ts", testing: "src/testing.ts", agents: "src/agents.ts", eslint: "src/eslint.ts", check: "src/check.ts" },
    format: ["esm", "cjs"],
    dts: true,
    target: "node20",
    sourcemap: true,
    external,
  },
  // The command only runs as ESM, so it gets no CommonJS build or types.
  { entry: { cli: "src/cli.ts" }, format: ["esm"], target: "node20", sourcemap: true, external },
]);
