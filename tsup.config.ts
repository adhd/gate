import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/hono": "src/adapters/hono.ts",
    "adapters/express": "src/adapters/express.ts",
    "store/index": "src/store/index.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ["hono", "express", "stripe"],
});
