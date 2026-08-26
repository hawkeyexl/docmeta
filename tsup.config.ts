import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    index: "src/index.ts",
  },
  format: ["esm"],
  target: "node24",
  platform: "node",
  // tsup strips `node:` prefixes by default (old-Node compat). `node:sqlite`
  // is a prefix-only builtin — `import("sqlite")` is a package that does not
  // exist — so the strip breaks `query` at runtime while raw esbuild output
  // is fine. Engines are >= 24; nothing needs the strip.
  removeNodeProtocol: false,
  clean: true,
  dts: true,
  sourcemap: true,
  // JSON schemas are imported via resolveJsonModule; bundle them in.
  banner: {
    js: "#!/usr/bin/env node",
  },
});
