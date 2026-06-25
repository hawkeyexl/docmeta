/**
 * Extractor registry. Maps file extensions to extractors and resolves an
 * extractor by name (for the `--as` override). Roadmap stubs are registered so
 * detection can report them clearly, but only implemented extractors count as
 * "supported" for directory walks.
 */
import type { MetadataExtractor } from "../types.js";
import { markdownExtractor } from "./markdown.js";
import { mdxExtractor } from "./mdx.js";
import { asciidocExtractor } from "./asciidoc.js";
import { rstExtractor } from "./rst.js";
import { xmlExtractor } from "./xml.js";
import { htmlExtractor } from "./html.js";

export const EXTRACTORS: MetadataExtractor[] = [
  markdownExtractor,
  mdxExtractor,
  asciidocExtractor,
  rstExtractor,
  xmlExtractor,
  htmlExtractor,
];

const byExtension = new Map<string, MetadataExtractor>();
const byName = new Map<string, MetadataExtractor>();
for (const ex of EXTRACTORS) {
  byName.set(ex.name, ex);
  for (const ext of ex.extensions) byExtension.set(ext.toLowerCase(), ex);
}

/** Resolve an implemented extractor for a file extension (incl. dot). */
export function extractorForExtension(
  ext: string,
): MetadataExtractor | undefined {
  const ex = byExtension.get(ext.toLowerCase());
  return ex?.implemented ? ex : undefined;
}

/** Resolve an extractor by its `--as` name (implemented or not). */
export function extractorByName(name: string): MetadataExtractor | undefined {
  return byName.get(name.toLowerCase());
}

/** Extensions handled by implemented extractors (used for directory walks). */
export function supportedExtensions(): string[] {
  return EXTRACTORS.filter((e) => e.implemented).flatMap((e) => e.extensions);
}

/** All registered format names, with their implemented status. */
export function listFormats(): { name: string; extensions: string[]; implemented: boolean }[] {
  return EXTRACTORS.map((e) => ({
    name: e.name,
    extensions: e.extensions,
    implemented: e.implemented,
  }));
}
