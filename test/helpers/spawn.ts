import type { SpawnSyncReturns } from "node:child_process";

/**
 * A `spawnSync` result, with the types Node actually produces.
 *
 * `@types/node` promises `stdout: string` once `encoding` is set. Node really
 * hands back `null` for both streams whenever the *spawn itself* failed — no
 * interpreter on PATH, a signal kill — and every `?? ""` at the call sites
 * depends on that. Something has to say so, or a type-aware reader takes those
 * guards for dead code and strips them.
 *
 * A function rather than an annotated `const`: TypeScript narrows an annotated
 * `const` straight back to its initializer's type, so the annotation buys
 * nothing at the use site.
 *
 * Shared rather than declared per file. Two suites spawn child processes and
 * both need this, and a guard that exists in two places is one someone edits in
 * one place — at which point the copy that was not updated still reads as
 * correct.
 */
export interface SpawnText {
  stdout: string | null;
  stderr: string | null;
  status: number | null;
}

export function spawnText(result: SpawnSyncReturns<string>): SpawnText {
  return result;
}
