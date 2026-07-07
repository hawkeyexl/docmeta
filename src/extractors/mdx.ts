/**
 * MDX extractor. MDX frontmatter is identical to Markdown's, so we reuse the
 * same logic (YAML/TOML/JSON fenced blocks). Parsing `export const meta = {...}`
 * is future work.
 */
import { extractFrontmatter } from "./frontmatter.js";
import type { MetadataExtractor } from "../types.js";

export const mdxExtractor: MetadataExtractor = {
  name: "mdx",
  extensions: [".mdx"],
  implemented: true,
  extract: (content) => extractFrontmatter(content, "mdx"),
};
