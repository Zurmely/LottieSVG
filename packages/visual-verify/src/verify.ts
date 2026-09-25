/**
 * Frame-by-frame fidelity check: renders the source SVG in Chrome (animations paused and seeked), the
 * converted Lottie in lottie-web, and the .lottie archive in the dotLottie (ThorVG) player, then diffs.
 *
 * Usage: pnpm verify <file.svg|dir...> [--frames 24] [--out verify-output] [--threshold 1.5] [--renderer svg|canvas]
 *        [--convert-options '{"fps":30}'] [--fonts dir]... [--no-google-fonts] [--font-cache dir]
 *
 * Fonts used to outline <text> are also served to the page as @font-face, so the browser draws the
 * original text with exactly the same font files.
 */
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { FontLibrary, convertSvg, resolveFonts, toDotLottie } from '@svg2lottie/core';
import { fsFontCache, loadFontDirectories, nodeFontFetcher } from '@svg2lottie/core/node';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

interface Args {
  files: string[];
  frames: number;
  out: string;
  threshold: number;
  renderer: string;
  chrome: string;
  convert: Record<string, unknown>;
  fonts: string[];
  google: boolean;
  fontCache?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    files: [],
    frames: 24,
    out: 'verify-output',
    threshold: 1.5,
    renderer: 'svg',
    chrome: process.env.CHROME_PATH ?? '/usr/local/bin/google-chrome',
    convert: {},
    fonts: [],
    google: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--frames') a.frames = Number(argv[++i]);
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--threshold') a.threshold = Number(argv[++i]);
    else if (v === '--renderer') a.renderer = argv[++i];
    else if (v === '--chrome') a.chrome = argv[++i];
    else if (v === '--convert-options') a.convert = JSON.parse(argv[++i]);
    else if (v === '--fonts') a.fonts.push(argv[++i]);
    else if (v === '--no-google-fonts') a.google = false;
    else if (v === '--font-cache') a.fontCache = argv[++i];
    else a.files.push(v);
  }
  if (!a.files.length) {
    console.error('usage: verify <file.svg...> [--frames N] [--out dir] [--threshold pct] [--renderer svg|canvas]');
    process.exit(2);
  }
  return a;
}

interface Expectation {
  reason: string;
  /** the mismatch is only accepted if the conversion reported all of these warning codes */
  warnings: string[];
}

/** `verify-expectations.json` next to a fixture lists files that intentionally differ from the browser. */
function expectationFor(file: string): Expectation | undefined {
  try {
    const table = JSON.parse(readFileSync(join(dirname(file), 'verify-expectations.json'), 'utf8')) as Record<string, Expectation>;
    return table[basename(file)];
  } catch {
    return undefined;
  }
}

function sideBySide(images: PNG[], gap = 4): PNG {
  const h = Math.max(...images.map((i) => i.height));
  const w = images.reduce((s, i) => s + i.width, 0) + gap * (images.length - 1);
  const out = new PNG({ width: w, height: h });
  out.data.fill(255);
  let x0 = 0;
  for (const img of images) {
    PNG.bitblt(img, out, 0, 0, img.width, img.height, x0, 0);
    x0 += img.width + gap;
  }
  return out;
}

interface Diff {
  /** % of pixels pixelmatch flags as different (perceptual, anti-aliasing excluded) */
  pct: number;
  /** mean absolute RGB error, 0–255 */
  mae: number;
  /** % of pixels with any RGB channel off by more than 8/255 */
  strictPct: number;
  /** % of pixels with any RGB channel off by more than 2/255 (catches faint glows) */
  finePct: number;
}

function diff(a: PNG, b: PNG, diffOut: PNG): Diff {
  const n = pixelmatch(a.data, b.data, diffOut.data, a.width, a.height, { threshold: 0.1, includeAA: false });
  let sum = 0;
  let strict = 0;
  let fine = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(a.data[i + c] - b.data[i + c]);
      sum += d;
      worst = Math.max(worst, d);
    }
    if (worst > 8) strict++;
    if (worst > 2) fine++;
  }
  const px = a.width * a.height;
  return { pct: (100 * n) / px, mae: sum / (px * 3), strictPct: (100 * strict) / px, finePct: (100 * fine) / px };
}

function fontFaceCss(library: FontLibrary): string {
  return library.faces
    .flatMap((face, i) =>
      face.families.map(
        (family) =>
          `@font-face { font-family: ${JSON.stringify(family)}; src: url(/font/${i}) format('${face.format}'); font-weight: ${face.weightRange[0]} ${face.weightRange[1]}; font-style: ${face.style}; }`,
      ),
    )
    .join('\n');
}

async function verifyFile(file: string, args: Args, browser: import('playwright-core').Browser, library: FontLibrary) {
  const svg = readFileSync(file, 'utf8');
  const fonts = await resolveFonts(svg, library, { google: args.google ? { fetcher: nodeFontFetcher, cache: fsFontCache(args.fontCache) } : false });
  for (const f of fonts) {
    const what = `${f.request.families.join(', ')} ${f.request.weight}${f.request.style !== 'normal' ? ` ${f.request.style}` : ''}`;
    console.log(`  font ${what}: ${f.resolved ? `${f.resolved.family} (${f.resolved.source})` : 'MISSING'}`);
  }
  const result = convertSvg(svg, { ...args.convert, fonts: library });
  const json = JSON.stringify(result.animation);
  const dot = toDotLottie(result.animation, { id: basename(file).replace(/\.svg$/i, '') });
  const { w, h, fr, op } = result.animation as { w: number; h: number; fr: number; op: number };
  const outDir = join(args.out, basename(file).replace(/\.svg$/i, ''));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'animation.json'), json);
  writeFileSync(join(outDir, 'animation.lottie'), dot);

  const files: Record<string, [string, string | Uint8Array]> = {
    '/': ['text/html', readFileSync(join(here, 'page.html'), 'utf8')],
    '/input.svg': ['image/svg+xml', svg],
    '/anim.json': ['application/json', json],
    '/anim.lottie': ['application/zip', dot],
    '/fonts.css': ['text/css', fontFaceCss(library)],
    ...Object.fromEntries(library.faces.map((face, i) => [`/font/${i}`, [`font/${face.format === 'opentype' ? 'otf' : face.format === 'truetype' ? 'ttf' : face.format}`, face.data] as [string, Uint8Array]])),
    '/lottie.js': ['text/javascript', readFileSync(require.resolve('lottie-web/build/player/lottie.min.js'))],
    '/dotlottie.js': ['text/javascript', readFileSync(join(dirname(require.resolve('@lottiefiles/dotlottie-web')), 'index.js'))],
    '/dotlottie-player.wasm': ['application/wasm', readFileSync(join(dirname(require.resolve('@lottiefiles/dotlottie-web')), 'dotlottie-player.wasm'))],
  };
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const f = files[path];
    if (!f) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': f[0] }).end(f[1]);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const page = await browser.newPage({ viewport: { width: w * 3 + 40, height: h + 20 }, deviceScaleFactor: 1 });
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/?w=${w}&h=${h}&renderer=${args.renderer}`);
  try {
    await page.waitForFunction('window.ready === true', null, { timeout: 20000 });
  } catch (e) {
    console.error(logs.join('\n'));
    throw e;
  }

  const frames = [...new Set(Array.from({ length: args.frames }, (_, k) => Math.round((k * op) / args.frames)))];
  // Looping animations with a delay are converted to their steady-state loop, which the browser only
  // reaches after the first cycle, so sample the browser one loop later.
  const steadyState = result.warnings.some((w) => w.code === 'loop-delay');
  const svgOffset = steadyState ? op : 0;
  if (steadyState) console.log(`  steady-state loop: sampling the browser SVG ${op} frames later`);
  const rows: { frame: number; lottieWeb: Diff; dotLottie: Diff }[] = [];
  const sheetRows: PNG[] = [];
  for (const frame of frames) {
    await page.evaluate(([f, fps, off]) => (window as unknown as { seek: (f: number, fps: number, off: number) => Promise<unknown> }).seek(f, fps, off), [frame, fr, svgOffset] as const);
    const shot = async (sel: string) => PNG.sync.read(await page.locator(sel).screenshot());
    const [s, l, d] = [await shot('#svg'), await shot('#lw'), await shot('#dl')];
    const dl = new PNG({ width: w, height: h });
    const dd = new PNG({ width: w, height: h });
    const row = { frame, lottieWeb: diff(s, l, dl), dotLottie: diff(s, d, dd) };
    rows.push(row);
    sheetRows.push(sideBySide([s, l, d, dl, dd]));
    const fmt = (x: Diff) => `${x.pct.toFixed(2)}% (strict ${x.strictPct.toFixed(2)}%, fine ${x.finePct.toFixed(2)}%, mae ${x.mae.toFixed(2)})`;
    console.log(`  frame ${String(frame).padStart(4)}  lottie-web ${fmt(row.lottieWeb)}  dotLottie ${fmt(row.dotLottie)}`);
  }
  await page.close();
  server.close();

  // Contact sheet: every other sampled frame, columns = SVG | lottie-web | dotLottie | diff(lw) | diff(dl)
  const picked = sheetRows.filter((_, k) => k % Math.max(1, Math.floor(sheetRows.length / 6)) === 0).slice(0, 6);
  const sheet = new PNG({ width: picked[0].width, height: picked.reduce((s, p) => s + p.height + 4, -4) });
  sheet.data.fill(255);
  let y = 0;
  for (const p of picked) {
    PNG.bitblt(p, sheet, 0, 0, p.width, p.height, 0, y);
    y += p.height + 4;
  }
  writeFileSync(join(outDir, 'contact-sheet.png'), PNG.sync.write(sheet));

  const maxLw = Math.max(...rows.map((r) => r.lottieWeb.pct));
  const maxDl = Math.max(...rows.map((r) => r.dotLottie.pct));
  const max = (k: 'lottieWeb' | 'dotLottie', m: keyof Diff) => Math.max(...rows.map((r) => r[k][m]));
  const maxDiff = Object.fromEntries(
    (['lottieWeb', 'dotLottie'] as const).map((k) => [k, { pct: max(k, 'pct'), strictPct: max(k, 'strictPct'), finePct: max(k, 'finePct'), mae: max(k, 'mae') }]),
  );
  const report = { file, stats: result.stats, warnings: result.warnings, fonts, accessibility: result.accessibility, threshold: args.threshold, maxDiff, frames: rows, browserLogs: logs };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const pass = maxLw <= args.threshold && maxDl <= args.threshold;
  const summary = `max diff lottie-web ${maxLw.toFixed(2)}%, dotLottie ${maxDl.toFixed(2)}% (threshold ${args.threshold}%) → ${outDir}`;
  const expectation = expectationFor(file);
  if (!pass && expectation) {
    const codes = new Set(result.warnings.map((w) => w.code));
    const missing = expectation.warnings.filter((c) => !codes.has(c));
    if (!missing.length) {
      console.log(`XFAIL ${file}: expected mismatch (${expectation.reason}); ${summary}`);
      return true;
    }
    console.log(`FAIL ${file}: expected warnings not reported: ${missing.join(', ')}; ${summary}`);
    return false;
  }
  console.log(`${pass ? 'PASS' : 'FAIL'} ${file}: ${summary}`);
  return pass;
}

const args = parseArgs(process.argv.slice(2));
const browser = await chromium.launch({ executablePath: args.chrome, args: ['--disable-gpu', '--force-color-profile=srgb', '--font-render-hinting=none', '--disable-lcd-text'] });
// pnpm runs scripts from the package directory; resolve paths against where the user invoked it.
const cwd = process.env.INIT_CWD ?? process.cwd();
const inputs = args.files.flatMap((f) => {
  const p = resolve(cwd, f);
  return statSync(p).isDirectory() ? readdirSync(p).filter((n) => n.toLowerCase().endsWith('.svg')).sort().map((n) => join(p, n)) : [p];
});
args.out = resolve(cwd, args.out);
const library = new FontLibrary();
const fontLoad = loadFontDirectories(library, args.fonts.map((d) => resolve(cwd, d)));
fontLoad.errors.forEach((e) => console.warn(`font: ${e}`));
let ok = true;
for (const f of inputs) {
  console.log(`Verifying ${f}`);
  ok = (await verifyFile(f, args, browser, library)) && ok;
}
await browser.close();
process.exit(ok ? 0 : 1);
