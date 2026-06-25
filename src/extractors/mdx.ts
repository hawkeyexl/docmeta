/**
 * MDX extractor. MDX frontmatter is identical to Markdown's YAML block, so we
 * reuse the same logic. Parsing `export const meta = {...}` is future work.
 */
import { extractFrontmatter } from "./markdown.js";
import type { MetadataExtractor } from "../types.js";

export const mdxExtractor: MetadataExtractor = {
  name: "mdx",
  extensions: [".mdx"],
  implemented: true,
  extract: (content) => extractFrontmatter(content, "mdx"),
};
