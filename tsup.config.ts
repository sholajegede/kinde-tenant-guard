import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", drizzle: "src/drizzle.ts" },
  format: ["esm", "cjs"],
  dts: true,
  target: "node20",
  sourcemap: true,
  external: ["drizzle-orm"],
});
