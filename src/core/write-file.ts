/**
 * Atomic file writes.
 *
 * `fill` is the first command that modifies the user's sources, and it does so
 * in bulk over a glob, often while a dev server or editor is watching. A
 * truncated write from a crash or a full disk would be unrecoverable for them,
 * so every write lands via a temp file plus `rename` — the file either has its
 * old contents or its new ones, never half of each.
 *
 * The temp file must live in the *same directory* as the target: `rename` is
 * only atomic within a filesystem, and the OS temp dir is frequently a
 * different one.
 */
import { writeFile, rename, rm, stat, chmod } from "node:fs/promises";
import { dirname, join, basename } from "node:path";

/** Windows returns these when an editor or scanner holds the target open. */
const LOCKED = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 3;

function errorCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code: unknown }).code)
    : undefined;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Write `contents` to `path`, replacing it atomically. Falls back to a direct
 * write (with a warning on stderr) if the rename keeps failing because the
 * target is locked — on Windows that is a real and recoverable situation, and
 * refusing to write at all would be worse than a non-atomic write.
 */
export async function writeFileAtomic(
  path: string,
  contents: string,
): Promise<void> {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.docmeta-${process.pid}-${Math.random().toString(36).slice(2, 8)}.tmp`,
  );

  try {
    await writeFile(tmp, contents, "utf8");

    // Carry the target's permissions over; a missing target just means we are
    // creating it, in which case the default mode is correct.
    try {
      const { mode } = await stat(path);
      await chmod(tmp, mode);
    } catch {
      // No existing file (or no permission to read its mode) — keep the default.
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
      try {
        await rename(tmp, path);
        return;
      } catch (err) {
        lastError = err;
        const code = errorCode(err);
        if (code == null || !LOCKED.has(code)) throw err;
        if (attempt < RENAME_ATTEMPTS) await wait(attempt * 50);
      }
    }

    process.stderr.write(
      `docmeta: ${path} is locked by another process; writing in place (not atomically).\n`,
    );
    try {
      await writeFile(path, contents, "utf8");
    } catch {
      throw lastError;
    }
  } finally {
    await rm(tmp, { force: true });
  }
}
