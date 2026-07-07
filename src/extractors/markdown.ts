/**
 * Markdown frontmatter extractor. Delegates to the shared, flavor-detecting
 * `extractFrontmatter`, which reads YAML (`--- … ---`), TOML (`+++ … +++`), or
 * JSON (`;;; … ;;;`) fenced front matter.
 */
import type { MetadataExtractor } from "../types.js";
import { extractFrontmatter } from "./frontmatter.js";

export const markdownExtractor: MetadataExtractor = {
  name: "markdown",
  extensions: [".md", ".markdown"],
  implemented: true,
  extract: (content) => extractFrontmatter(content, "markdown"),
};
