import { defineConfig } from "tsup";

export default defineConfig([
  // Library build — hono/express/stripe stay external
  {
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
  },
  // CLI build — bundles hono + @hono/node-server so npx works standalone
  {
    entry: { cli: "src/cli.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: false,
    banner: { js: "#!/usr/bin/env node" },
    noExternal: [/(.*)/],
    external: ["stripe"],
  },
]);
