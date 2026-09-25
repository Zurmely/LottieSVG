import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fromDotLottie, memoryFontCache, type FontFetcher } from '@svg2lottie/core';
import { run, type Io } from '../src/run.js';

const fixtures = join(__dirname, '../../core/test/fixtures');
const fonts = join(__dirname, '../../core/test/fonts');
const offline = ['--no-google-fonts'];

function makeIo(stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  let written = '';
  const io: Io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readStdin: () => stdin,
    writeStdout: (s) => (written += s),
  };
  return { io, out, err, written: () => written };
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'svg2lottie-'));
});

describe('svg2lottie CLI', () => {
  it('converts a single file to the given .json path', async () => {
    const { io, out } = makeIo();
    const target = join(tmp, 'nested', 'out.json');
    expect(await run([join(fixtures, 'figma-motion-sample.svg'), '-o', target], io)).toBe(0);
    const anim = JSON.parse(readFileSync(target, 'utf8'));
    expect(anim).toMatchObject({ fr: 60, op: 240, w: 512, h: 512, nm: 'figma-motion-sample' });
    expect(out[0]).toMatch(/figma-motion-sample\.svg → .*out\.json/);
  });

  it('infers dotLottie from the output extension', async () => {
    const { io } = makeIo();
    const target = join(tmp, 'out.lottie');
    expect(await run([join(fixtures, 'shapes-static.svg'), '-o', target], io)).toBe(0);
    const { animation, manifest } = fromDotLottie(new Uint8Array(readFileSync(target)));
    expect(animation.w).toBe(200);
    expect(manifest).toMatchObject({ animations: [{ id: 'shapes-static' }] });
  });

  it('batch converts a directory into an output directory with both formats', async () => {
    const src = join(tmp, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    copyFileSync(join(fixtures, 'shapes-static.svg'), join(src, 'a.svg'));
    copyFileSync(join(fixtures, 'gradients.svg'), join(src, 'sub', 'b.svg'));
    const { io, out } = makeIo();
    expect(await run([src, '-o', join(tmp, 'out'), '-f', 'both', '-r'], io)).toBe(0);
    for (const f of ['a.json', 'a.lottie', 'sub/b.json', 'sub/b.lottie']) expect(existsSync(join(tmp, 'out', f))).toBe(true);
    expect(out.at(-1)).toBe('2/2 converted');
  });

  it('skips subdirectories without --recursive', async () => {
    const src = join(tmp, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    copyFileSync(join(fixtures, 'gradients.svg'), join(src, 'sub', 'b.svg'));
    const { io, err } = makeIo();
    expect(await run([src], io)).toBe(2);
    expect(err[0]).toMatch(/no \.svg files/);
  });

  it('reports warnings and fails with --strict', async () => {
    const { io, err } = makeIo();
    const target = join(tmp, 'u.json');
    expect(await run([join(fixtures, 'unsupported.svg'), '-o', target, ...offline], io)).toBe(0);
    expect(err.join('\n')).toMatch(/Font not found: NoSuchFontFamily/);
    expect(await run([join(fixtures, 'unsupported.svg'), '-o', target, '--strict', '-q', ...offline], makeIo().io)).toBe(1);
  });

  it('reads stdin and writes JSON to stdout', async () => {
    const { io, written } = makeIo('<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="red"/></svg>');
    expect(await run(['-', '--fps', '30'], io)).toBe(0);
    expect(JSON.parse(written())).toMatchObject({ fr: 30, w: 10 });
  });

  it('keeps going after an invalid file and exits 1', async () => {
    const bad = join(tmp, 'bad.svg');
    writeFileSync(bad, '<html/>');
    const good = join(tmp, 'good.svg');
    copyFileSync(join(fixtures, 'shapes-static.svg'), good);
    const { io, err } = makeIo();
    expect(await run([bad, good], io)).toBe(1);
    expect(err.join('\n')).toMatch(/bad\.svg: Invalid SVG/);
    expect(existsSync(join(tmp, 'good.json'))).toBe(true);
  });

  it('rejects bad options and missing inputs', async () => {
    expect(await run(['x.svg', '--format', 'gif'], makeIo().io)).toBe(2);
    expect(await run([join(tmp, 'missing.svg')], makeIo().io)).toBe(2);
  });

  it('outlines text with --fonts and writes accessibility metadata, overridable with --alt', async () => {
    const target = join(tmp, 'text.lottie');
    const { io, err } = makeIo();
    expect(await run([join(fixtures, 'text-basic.svg'), '-o', target, '--fonts', fonts, '--strict', ...offline], io)).toBe(0);
    expect(err.join('\n')).not.toMatch(/font-missing/);
    const { manifest, animation } = fromDotLottie(new Uint8Array(readFileSync(target)));
    expect((manifest as { description: string }).description).toMatch(/^AVATAR To office/);
    expect(animation.layers.some((l: { nm: string }) => l.nm === 'Text "Centered bold"')).toBe(true);
    const alt = join(tmp, 'alt.json');
    expect(await run([join(fixtures, 'text-basic.svg'), '-o', alt, '--fonts', fonts, '--alt', 'Type specimen', ...offline], makeIo().io)).toBe(0);
    expect(JSON.parse(readFileSync(alt, 'utf8')).meta).toMatchObject({ d: 'Type specimen', a11y: { source: 'alt' } });
  });

  it('fails under --strict when a font is missing, with a clear message', async () => {
    const { io, err } = makeIo();
    const code = await run([join(fixtures, 'text-missing-font.svg'), '-o', join(tmp, 'm.json'), '--strict', ...offline], io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/Font not found: Definitely Not A Real Font 400/);
    expect(await run([join(fixtures, 'text-missing-font.svg'), '-o', join(tmp, 'm.json'), ...offline], makeIo().io)).toBe(0);
  });

  it('downloads missing fonts from Google Fonts (injected fetcher) and reports it', async () => {
    const fetched: string[] = [];
    const fetcher: FontFetcher = {
      fetchText: async (url) => {
        fetched.push(url);
        return `@font-face { font-family: 'Roboto'; font-style: normal; font-weight: 400; src: url(https://fonts.gstatic.com/r.ttf) format('truetype'); }`;
      },
      fetchBinary: async (url) => {
        fetched.push(url);
        return new Uint8Array(readFileSync(join(fonts, 'Roboto-Regular.ttf')));
      },
    };
    const svg = join(tmp, 'g.svg');
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><text y="30" font-family="Roboto">Hi</text></svg>');
    const { io, err } = makeIo();
    expect(await run([svg, '--strict'], io, { google: { fetcher, cache: memoryFontCache() } })).toBe(0);
    expect(fetched[0]).toBe('https://fonts.googleapis.com/css2?family=Roboto:wght@400');
    expect(err.join('\n')).toMatch(/font: Roboto 400 from Google Fonts/);
    expect(JSON.parse(readFileSync(join(tmp, 'g.json'), 'utf8')).meta.a11y.texts[0].text).toBe('Hi');
  });
});
