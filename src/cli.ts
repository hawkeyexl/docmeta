/**
 * docmeta CLI. Thin commander wrapper over the command cores. Follows clig.dev:
 * primary output to stdout, diagnostics to stderr, color only on a TTY (and
 * never when NO_COLOR/--no-color), meaningful exit codes (0 ok, 1 validation
 * failures, 2 operational/usage errors).
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { DocmetaError } from "./types.js";
import { runValidate } from "./commands/validate.js";
import { runGet } from "./commands/get.js";
import { getSchemasInfo } from "./commands/schemas.js";
import { render, type ReportFormat } from "./reporters/index.js";
import { shouldColor, palette } from "./reporters/color.js";

function collect(value: string, prev: string[]): string[] {
  return prev.concat([value]);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function fail(err: unknown): never {
  const msg =
    err instanceof DocmetaError
      ? err.message
      : `Unexpected error: ${(err as Error).message}`;
  process.stderr.write(`docmeta: ${msg}\n`);
  process.exit(2);
}

function resolveColor(program: Command): boolean {
  // commander maps --no-color to opts.color === false.
  const noColor = program.opts().color === false;
  return shouldColor({ noColor, isTTY: Boolean(process.stdout.isTTY) });
}

function stringifyValue(v: unknown): string {
  if (v === undefined) return "(unset)";
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

const REPORT_FORMATS = new Set(["pretty", "json", "github"]);

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("docmeta")
    .description(
      "Validate the presence and format of document metadata against JSON Schema.",
    )
    .version(pkg.version, "-V, --version")
    .option("--no-color", "disable colored output")
    .showHelpAfterError();

  program
    .command("validate", { isDefault: true })
    .description("Validate metadata in the given files/dirs/globs")
    .argument(
      "[paths...]",
      "files, directories, or globs to validate (use - for stdin)",
    )
    .option(
      "-s, --schema <ref>",
      "schema to validate against; repeatable; overrides $schema/config",
      collect,
      [],
    )
    .option("--ext <list>", "comma-separated extensions for directory walks")
    .option("--exclude <glob>", "glob to exclude; repeatable", collect, [])
    .option("--as <format>", "force an input format (e.g. markdown, mdx)")
    .option("-f, --format <format>", "output: pretty | json | github", "pretty")
    .option("-c, --config <path>", "path to a docmeta config file")
    .option("-q, --quiet", "in pretty output, hide passing files")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  docmeta validate docs/                       # walk a directory",
        '  docmeta validate "**/*.md" -f github         # CI annotations',
        "  docmeta validate page.md -s google:okf:0.1 -s ./my.schema.json",
        "  cat page.md | docmeta validate - --as markdown",
      ].join("\n"),
    )
    .action(async (paths: string[], options, command: Command) => {
      try {
        const format = options.format as ReportFormat;
        if (!REPORT_FORMATS.has(format)) {
          throw new DocmetaError(
            `Unknown --format "${format}". Use pretty, json, or github.`,
          );
        }
        const exts: string[] | undefined = options.ext
          ? String(options.ext)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        const stdinContent = paths.includes("-")
          ? await readStdin()
          : undefined;

        const { results, summary } = await runValidate({
          inputs: paths,
          cliSchemas: options.schema,
          exts,
          exclude: options.exclude,
          as: options.as,
          configPath: options.config,
          stdinContent,
        });

        const color = resolveColor(command.parent ?? command);
        const text = render(format, results, summary, {
          color,
          quiet: Boolean(options.quiet),
        });
        if (text.length > 0) process.stdout.write(`${text}\n`);
        process.exitCode = summary.failed > 0 ? 1 : 0;
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("get")
    .description(
      "Print metadata field values from the given files/dirs/globs",
    )
    .argument("<fields>", "comma-separated metadata fields to print")
    .argument(
      "[paths...]",
      "files, directories, or globs to read (use - for stdin)",
    )
    .option("--ext <list>", "comma-separated extensions for directory walks")
    .option("--exclude <glob>", "glob to exclude; repeatable", collect, [])
    .option("--as <format>", "force an input format (e.g. markdown, mdx)")
    .option("-f, --format <format>", "output: pretty | json", "pretty")
    .option("-c, --config <path>", "path to a docmeta config file")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  docmeta get title,type docs/intro.md",
        '  docmeta get type "**/*.md" -f json',
        "  cat page.md | docmeta get title - --as markdown",
      ].join("\n"),
    )
    .action(async (fieldsArg: string, paths: string[], options, command: Command) => {
      try {
        const format = options.format as string;
        if (format !== "pretty" && format !== "json") {
          throw new DocmetaError(
            `Unknown --format "${format}". Use pretty or json.`,
          );
        }
        const fields = String(fieldsArg)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const exts: string[] | undefined = options.ext
          ? String(options.ext)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
          : undefined;
        const stdinContent = paths.includes("-")
          ? await readStdin()
          : undefined;

        const results = await runGet({
          fields,
          inputs: paths,
          as: options.as,
          exclude: options.exclude,
          exts,
          configPath: options.config,
          stdinContent,
        });
        if (format === "json") {
          process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
        } else {
          const c = palette(resolveColor(command.parent ?? command));
          for (const r of results) {
            for (const f of fields) {
              process.stdout.write(
                `${c.dim(`${r.file}:`)} ${f}=${stringifyValue(r.values[f])}\n`,
              );
            }
          }
        }
      } catch (err) {
        fail(err);
      }
    });

  program
    .command("schemas")
    .description("List built-in schemas and supported input formats")
    .option("-f, --format <format>", "output: pretty | json", "pretty")
    .action((options, command: Command) => {
      const info = getSchemasInfo();
      if (options.format === "json") {
        process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
        return;
      }
      const c = palette(resolveColor(command.parent ?? command));
      const lines: string[] = [c.bold("Built-in schemas:")];
      for (const b of info.builtins) {
        lines.push(`  ${c.cyan(b.id)}  ${c.dim("—")}  ${b.title}`);
      }
      lines.push("", c.bold("Input formats:"));
      for (const f of info.formats) {
        const tag = f.implemented ? c.green("implemented") : c.dim("planned");
        lines.push(`  ${f.name} (${f.extensions.join(", ")})  [${tag}]`);
      }
      process.stdout.write(`${lines.join("\n")}\n`);
    });

  return program;
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}

/** Run only when executed directly (not when imported by tests). */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main().catch(fail);
}
