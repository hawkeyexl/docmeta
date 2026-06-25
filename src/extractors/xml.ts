import { createStubExtractor } from "./stub.js";

// Roadmap: read root-element attributes or a configured metadata element into a
// metadata object.
export const xmlExtractor = createStubExtractor(
  "xml",
  [".xml"],
  "XML root attributes / metadata element",
);
