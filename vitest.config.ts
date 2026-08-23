import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      // `text` for the CI log, `lcov` for anything that wants to ingest it.
      // `html` is deliberately absent: nothing here serves it, and it is the
      // slowest reporter to write.
      reporter: ["text", "lcov"],
      // Naming the sources explicitly is the whole point. Left to the default,
      // coverage reports only files some test already imported — so a module
      // with no test at all is not 0%, it is *absent*, and the summary reads
      // better the less of the codebase it covers. `include` makes an untested
      // file show up as the zero it is.
      include: ["src/**/*.ts"],
      // JSON Schema documents, not code. They are `resolveJsonModule` imports
      // with no statements to cover, and counting them would move the number
      // without anyone having tested anything.
      exclude: ["src/schemas/**"],
      // No thresholds yet, on purpose. A gate invented before the first real
      // measurement either sits so low it never fires or so high it fails the
      // build on day one; the number this produces is what a later ratchet
      // should be set just below.
    },
  },
});
