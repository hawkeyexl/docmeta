import pc from "picocolors";

export type Colors = ReturnType<typeof pc.createColors>;

/** Build a picocolors palette with color explicitly on or off. */
export function palette(enabled: boolean): Colors {
  return pc.createColors(enabled);
}

/**
 * Decide whether to emit ANSI color: off when `--no-color`/`NO_COLOR`, on only
 * for a TTY otherwise. `forced` (from `--color`) overrides detection.
 */
export function shouldColor(opts: {
  noColor?: boolean;
  isTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const env = opts.env ?? process.env;
  if (opts.noColor) return false;
  if (env.NO_COLOR != null && env.NO_COLOR !== "") return false;
  return Boolean(opts.isTTY);
}
