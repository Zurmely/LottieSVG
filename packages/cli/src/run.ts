import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { convertSvg, toDotLottie, type ConversionWarning } from '@svg2lottie/core';

export interface Io {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readStdin: () => string;
  writeStdout: (data: string) => void;
}

type Format = 'json' | 'lottie' | 'both';

interface Options {
  output?: string;
  format?: Format;
  fps: number;
  precision: number;
  maxDuration: number;
  pretty: boolean;
  strict: boolean;
  quiet: boolean;
  blur: boolean;
  recursive: boolean;
}

const positiveNumber = (v: string) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError('must be a positive number');
  return n;
};

function collectInputs(inputs: string[], recursive: boolean): { file: string; root: string }[] {
  const out: { file: string; root: string }[] = [];
  const walk = (dir: string, root: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        if (recursive) walk(p, root);
      } else if (extname(entry).toLowerCase() === '.svg') out.push({ file: p, root });
    }
  };
  for (const input of inputs) {
    const st = statSync(input, { throwIfNoEntry: false });
    if (!st) throw new Error(`Input not found: ${input}`);
    if (st.isDirectory()) walk(input, input);
    else out.push({ file: input, root: dirname(input) });
  }
  return out;
}

function formatWarning(w: ConversionWarning): string {
  const where = w.element ? ` [${w.element}]` : '';
  return `  ${w.severity === 'info' ? 'info' : w.severity}${where}: ${w.message} (${w.code})`;
}

export function run(argv: string[], io: Io): number {
  const program = new Command()
    .name('svg2lottie')
    .description('Convert animated SVG (Figma Motion, CSS @keyframes, SMIL) to Lottie JSON and dotLottie.')
    .argument('<inputs...>', 'SVG files or directories ("-" reads stdin)')
    .option('-o, --output <path>', 'output file (single input) or directory')
    .option('-f, --format <format>', 'json | lottie | both (default: from -o extension, else json)', (v) => {
      if (!['json', 'lottie', 'both'].includes(v)) throw new InvalidArgumentError('expected json, lottie or both');
      return v as Format;
    })
    .option('--fps <n>', 'output frame rate', positiveNumber, 60)
    .option('--precision <n>', 'decimal places in output', (v) => parseInt(v, 10), 3)
    .option('--max-duration <s>', 'cap for the unrolled loop length in seconds', positiveNumber, 30)
    .option('--no-blur', 'drop blur filters instead of emitting Lottie blur effects')
    .option('-r, --recursive', 'recurse into subdirectories', false)
    .option('--pretty', 'pretty-print JSON', false)
    .option('--strict', 'exit with code 1 if any warning is reported', false)
    .option('-q, --quiet', 'only print errors', false)
    .exitOverride()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  try {
    program.parse(argv, { from: 'user' });
  } catch (e) {
    const code = (e as { exitCode?: number }).exitCode;
    return code === 0 ? 0 : 2;
  }
  const opts = program.opts<Options>();
  const inputs = program.args;
  const convertOptions = { fps: opts.fps, precision: opts.precision, maxDuration: opts.maxDuration, blur: opts.blur };

  if (inputs.length === 1 && inputs[0] === '-') {
    try {
      const result = convertSvg(io.readStdin(), convertOptions);
      result.warnings.forEach((w) => !opts.quiet && io.stderr(formatWarning(w)));
      if (opts.output) writeOutputs(result.animation, opts.output, resolveFormats(opts.format, opts.output), opts.pretty, 'animation');
      else io.writeStdout(JSON.stringify(result.animation, null, opts.pretty ? 2 : undefined));
      return opts.strict && result.warnings.some((w) => w.severity !== 'info') ? 1 : 0;
    } catch (e) {
      io.stderr(`error: ${(e as Error).message}`);
      return 1;
    }
  }

  let files: { file: string; root: string }[];
  try {
    files = collectInputs(inputs, opts.recursive);
  } catch (e) {
    io.stderr(`error: ${(e as Error).message}`);
    return 2;
  }
  if (!files.length) {
    io.stderr('error: no .svg files found');
    return 2;
  }
  const single = files.length === 1 && !statSync(inputs[0]).isDirectory();
  const outIsFile = single && opts.output !== undefined && /\.(json|lottie)$/i.test(opts.output);
  let failures = 0;
  let warned = 0;
  for (const { file, root } of files) {
    const stem = basename(file, extname(file));
    try {
      const result = convertSvg(readFileSync(file, 'utf8'), { ...convertOptions, name: stem });
      let base: string;
      if (outIsFile) base = opts.output!.replace(/\.(json|lottie)$/i, '');
      else {
        const outDir = opts.output ?? dirname(file);
        const rel = opts.output ? relative(root, dirname(file)) : '';
        base = join(outDir, rel, stem);
      }
      const formats = resolveFormats(opts.format, outIsFile ? opts.output : undefined);
      const written = writeOutputs(result.animation, base, formats, opts.pretty, stem);
      const issues = result.warnings.filter((w) => w.severity !== 'info');
      if (issues.length) warned++;
      if (!opts.quiet) {
        io.stdout(`✔ ${file} → ${written.join(', ')}  (${result.stats.durationSeconds}s @ ${result.stats.fps}fps, ${result.stats.layers} layers, ${issues.length} warning${issues.length === 1 ? '' : 's'})`);
        result.warnings.forEach((w) => io.stderr(formatWarning(w)));
      }
    } catch (e) {
      failures++;
      io.stderr(`✖ ${file}: ${(e as Error).message}`);
    }
  }
  if (files.length > 1 && !opts.quiet) io.stdout(`${files.length - failures}/${files.length} converted${warned ? `, ${warned} with warnings` : ''}`);
  if (failures) return 1;
  return opts.strict && warned ? 1 : 0;
}

function resolveFormats(format: Format | undefined, outputPath: string | undefined): ('json' | 'lottie')[] {
  const f = format ?? (outputPath?.toLowerCase().endsWith('.lottie') ? 'lottie' : 'json');
  return f === 'both' ? ['json', 'lottie'] : [f];
}

function writeOutputs(animation: object, base: string, formats: ('json' | 'lottie')[], pretty: boolean, id: string): string[] {
  const stripped = base.replace(/\.(json|lottie)$/i, '');
  mkdirSync(dirname(resolve(stripped)), { recursive: true });
  return formats.map((f) => {
    const path = `${stripped}.${f}`;
    if (f === 'json') writeFileSync(path, JSON.stringify(animation, null, pretty ? 2 : undefined));
    else writeFileSync(path, toDotLottie(animation, { id }));
    return path;
  });
}
