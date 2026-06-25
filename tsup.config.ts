import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  clean: true,
  dts: true,
  sourcemap: true,
  // JSON schemas are imported via resolveJsonModule; bundle them in.
  banner: {
    js: "#!/usr/bin/env node",
  },
});
