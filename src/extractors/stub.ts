/**
 * Factory for roadmap extractors: formats whose interface is defined but whose
 * parsing is not yet implemented. They are registered so detection can give a
 * clear "not yet implemented" message, and so adding the real parser later is
 * an isolated change to a single file.
 */
import { DocmetaError, type MetadataExtractor } from "../types.js";

export function createStubExtractor(
  name: string,
  extensions: string[],
  note: string,
): MetadataExtractor {
  return {
    name,
    extensions,
    implemented: false,
    extract() {
      throw new DocmetaError(
        `The "${name}" metadata format is not yet implemented (${note}).`,
      );
    },
  };
}
