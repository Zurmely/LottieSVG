import { mkdtempSync, mkdirSync, readFileSync, copyFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { fromDotLottie } from '@svg2lottie/core';
import { run, type Io } from '../src/run.js';

const fixtures = join(__dirname, '../../core/test/fixtures');

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
  it('converts a single file to the given .json path', () => {
    const { io, out } = makeIo();
    const target = join(tmp, 'nested', 'out.json');
    expect(run([join(fixtures, 'figma-motion-sample.svg'), '-o', target], io)).toBe(0);
    const anim = JSON.parse(readFileSync(target, 'utf8'));
    expect(anim).toMatchObject({ fr: 60, op: 240, w: 512, h: 512, nm: 'figma-motion-sample' });
    expect(out[0]).toMatch(/figma-motion-sample\.svg → .*out\.json/);
  });

  it('infers dotLottie from the output extension', () => {
    const { io } = makeIo();
    const target = join(tmp, 'out.lottie');
    expect(run([join(fixtures, 'shapes-static.svg'), '-o', target], io)).toBe(0);
    const { animation, manifest } = fromDotLottie(new Uint8Array(readFileSync(target)));
    expect(animation.w).toBe(200);
    expect(manifest).toMatchObject({ animations: [{ id: 'shapes-static' }] });
  });

  it('batch converts a directory into an output directory with both formats', () => {
    const src = join(tmp, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    copyFileSync(join(fixtures, 'shapes-static.svg'), join(src, 'a.svg'));
    copyFileSync(join(fixtures, 'gradients.svg'), join(src, 'sub', 'b.svg'));
    const { io, out } = makeIo();
    expect(run([src, '-o', join(tmp, 'out'), '-f', 'both', '-r'], io)).toBe(0);
    for (const f of ['a.json', 'a.lottie', 'sub/b.json', 'sub/b.lottie']) expect(existsSync(join(tmp, 'out', f))).toBe(true);
    expect(out.at(-1)).toBe('2/2 converted');
  });

  it('skips subdirectories without --recursive', () => {
    const src = join(tmp, 'src');
    mkdirSync(join(src, 'sub'), { recursive: true });
    copyFileSync(join(fixtures, 'gradients.svg'), join(src, 'sub', 'b.svg'));
    const { io, err } = makeIo();
    expect(run([src], io)).toBe(2);
    expect(err[0]).toMatch(/no \.svg files/);
  });

  it('reports warnings and fails with --strict', () => {
    const { io, err } = makeIo();
    const target = join(tmp, 'u.json');
    expect(run([join(fixtures, 'unsupported.svg'), '-o', target], io)).toBe(0);
    expect(err.join('\n')).toMatch(/Text is not supported/);
    expect(run([join(fixtures, 'unsupported.svg'), '-o', target, '--strict', '-q'], makeIo().io)).toBe(1);
  });

  it('reads stdin and writes JSON to stdout', () => {
    const { io, written } = makeIo('<svg viewBox="0 0 10 10"><rect width="4" height="4" fill="red"/></svg>');
    expect(run(['-', '--fps', '30'], io)).toBe(0);
    expect(JSON.parse(written())).toMatchObject({ fr: 30, w: 10 });
  });

  it('keeps going after an invalid file and exits 1', () => {
    const bad = join(tmp, 'bad.svg');
    writeFileSync(bad, '<html/>');
    const good = join(tmp, 'good.svg');
    copyFileSync(join(fixtures, 'shapes-static.svg'), good);
    const { io, err } = makeIo();
    expect(run([bad, good], io)).toBe(1);
    expect(err.join('\n')).toMatch(/bad\.svg: Invalid SVG/);
    expect(existsSync(join(tmp, 'good.json'))).toBe(true);
  });

  it('rejects bad options and missing inputs', () => {
    expect(run(['x.svg', '--format', 'gif'], makeIo().io)).toBe(2);
    expect(run([join(tmp, 'missing.svg')], makeIo().io)).toBe(2);
  });
});
