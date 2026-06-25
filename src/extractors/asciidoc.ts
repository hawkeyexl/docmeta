import { createStubExtractor } from "./stub.js";

// Roadmap: parse the AsciiDoc document header — title line and `:key: value`
// attribute entries — into a metadata object.
export const asciidocExtractor = createStubExtractor(
  "asciidoc",
  [".adoc", ".asciidoc"],
  "AsciiDoc header attributes",
);
