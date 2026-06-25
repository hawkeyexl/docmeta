import { createStubExtractor } from "./stub.js";

// Roadmap: parse reStructuredText docinfo field lists (`:key: value`) into a
// metadata object.
export const rstExtractor = createStubExtractor(
  "rst",
  [".rst"],
  "reStructuredText field lists / docinfo",
);
