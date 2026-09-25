/**
 * Frame-by-frame fidelity check: renders the source SVG in Chrome (animations paused and seeked), the
 * converted Lottie in lottie-web, and the .lottie archive in the dotLottie (ThorVG) player, then diffs.
 *
 * Usage: pnpm verify <file.svg...> [--frames 24] [--out verify-output] [--threshold 1.5] [--renderer svg|canvas]
 *        [--convert-options '{"fps":30}']
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { convertSvg, toDotLottie } from '@svg2lottie/core';

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
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--frames') a.frames = Number(argv[++i]);
    else if (v === '--out') a.out = argv[++i];
    else if (v === '--threshold') a.threshold = Number(argv[++i]);
    else if (v === '--renderer') a.renderer = argv[++i];
    else if (v === '--chrome') a.chrome = argv[++i];
    else if (v === '--convert-options') a.convert = JSON.parse(argv[++i]);
    else a.files.push(v);
  }
  if (!a.files.length) {
    console.error('usage: verify <file.svg...> [--frames N] [--out dir] [--threshold pct] [--renderer svg|canvas]');
    process.exit(2);
  }
  return a;
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

async function verifyFile(file: string, args: Args, browser: import('playwright-core').Browser) {
  const svg = readFileSync(file, 'utf8');
  const result = convertSvg(svg, args.convert);
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
  const rows: { frame: number; lottieWeb: Diff; dotLottie: Diff }[] = [];
  const sheetRows: PNG[] = [];
  for (const frame of frames) {
    await page.evaluate(([f, fps]) => (window as unknown as { seek: (f: number, fps: number) => Promise<unknown> }).seek(f, fps), [frame, fr] as const);
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
  const report = { file, stats: result.stats, warnings: result.warnings, threshold: args.threshold, maxDiff, frames: rows, browserLogs: logs };
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const pass = maxLw <= args.threshold && maxDl <= args.threshold;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${file}: max diff lottie-web ${maxLw.toFixed(2)}%, dotLottie ${maxDl.toFixed(2)}% (threshold ${args.threshold}%) → ${outDir}`);
  return pass;
}

const args = parseArgs(process.argv.slice(2));
const browser = await chromium.launch({ executablePath: args.chrome, args: ['--disable-gpu', '--force-color-profile=srgb', '--font-render-hinting=none'] });
let ok = true;
for (const f of args.files) {
  console.log(`Verifying ${f}`);
  ok = (await verifyFile(resolve(f), args, browser)) && ok;
}
await browser.close();
process.exit(ok ? 0 : 1);
