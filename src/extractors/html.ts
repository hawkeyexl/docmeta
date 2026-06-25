import { createStubExtractor } from "./stub.js";

// Roadmap: read `<meta name=... content=...>` tags and `<title>` from the
// document head into a metadata object.
export const htmlExtractor = createStubExtractor(
  "html",
  [".html", ".htm"],
  "HTML <meta> tags and <title>",
);
