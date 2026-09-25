import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { convertSvg, fromDotLottie, toDotLottie, type LottieAnimation } from '../src/index.js';

const dir = join(__dirname, 'fixtures');
const load = (name: string) => readFileSync(join(dir, name), 'utf8');

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Structural sanity checks that every player relies on. */
function validateLottie(anim: LottieAnimation): string[] {
  const errors: string[] = [];
  for (const key of ['v', 'fr', 'ip', 'op', 'w', 'h', 'layers']) if (!(key in anim)) errors.push(`missing ${key}`);
  const checkProp = (p: Obj, path: string) => {
    if (!p || (p.a !== 0 && p.a !== 1)) return errors.push(`${path}: bad animatable`);
    if (p.a === 1) {
      if (!Array.isArray(p.k) || p.k.length < 2) errors.push(`${path}: animated with < 2 keyframes`);
      let last = -Infinity;
      p.k.forEach((kf: Obj, i: number) => {
        if (!(kf.t > last)) errors.push(`${path}: keyframe times not increasing`);
        last = kf.t;
        if (!Array.isArray(kf.s)) errors.push(`${path}: keyframe without s[]`);
        if (i < p.k.length - 1 && !kf.h && (!kf.o || !kf.i)) errors.push(`${path}: missing easing handles`);
      });
    }
  };
  const walkShapes = (items: Obj[], path: string) => {
    for (const it of items) {
      const p = `${path}/${it.ty}:${it.nm}`;
      if (it.ty === 'gr') {
        if (it.it[it.it.length - 1]?.ty !== 'tr') errors.push(`${p}: group without trailing transform`);
        walkShapes(it.it, p);
      } else if (it.ty === 'tr') ['p', 'a', 's', 'r', 'o'].forEach((k) => checkProp(it[k], `${p}.${k}`));
      else if (it.ty === 'sh') checkProp(it.ks, `${p}.ks`);
      else if (it.ty === 'rc') ['p', 's', 'r'].forEach((k) => checkProp(it[k], `${p}.${k}`));
      else if (it.ty === 'el') ['p', 's'].forEach((k) => checkProp(it[k], `${p}.${k}`));
      else if (it.ty === 'fl' || it.ty === 'st') ['c', 'o'].forEach((k) => checkProp(it[k], `${p}.${k}`));
      else if (it.ty === 'gf' || it.ty === 'gs') ['s', 'e', 'o'].forEach((k) => checkProp(it[k], `${p}.${k}`));
      else errors.push(`${p}: unexpected shape type`);
    }
  };
  const walkLayers = (layers: Obj[], path: string) => {
    const inds = new Set<number>();
    for (const l of layers) {
      if (inds.has(l.ind)) errors.push(`${path}: duplicate ind ${l.ind}`);
      inds.add(l.ind);
      ['o', 'p', 'a', 's', 'r'].forEach((k) => checkProp(l.ks[k], `${path}/${l.nm}.ks.${k}`));
      if (l.ty === 4) walkShapes(l.shapes, `${path}/${l.nm}`);
      if (l.ty === 0 && !anim.assets.some((a: Obj) => a.id === l.refId)) errors.push(`${path}/${l.nm}: missing precomp asset`);
      if (l.parent !== undefined && !layers.some((o) => o.ind === l.parent)) errors.push(`${path}/${l.nm}: bad parent`);
    }
  };
  walkLayers(anim.layers, '');
  for (const a of anim.assets ?? []) walkLayers(a.layers, `asset:${a.id}`);
  return errors;
}

const find = (items: Obj[], pred: (o: Obj) => boolean): Obj | undefined => {
  for (const it of items) {
    if (pred(it)) return it;
    const nested = it.it ?? it.shapes ?? it.layers;
    if (Array.isArray(nested)) {
      const r = find(nested, pred);
      if (r) return r;
    }
  }
  return undefined;
};

describe('fixtures produce structurally valid Lottie', () => {
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.svg'))) {
    it(file, () => {
      const { animation } = convertSvg(load(file));
      expect(validateLottie(animation)).toEqual([]);
    });
  }
});

describe('Figma Motion export (primary fixture)', () => {
  const result = convertSvg(load('figma-motion-sample.svg'));
  const layers = result.animation.layers as Obj[];
  const layer = (name: string) => layers.find((l) => l.nm === name)!;

  it('produces a 4s 512×512 loop at 60fps with one layer per element', () => {
    expect(result.stats).toMatchObject({ width: 512, height: 512, fps: 60, durationSeconds: 4, frames: 240, layers: 7 });
    expect(layers.map((l) => l.nm)).toEqual(['orbit-dot-2', 'orbit-dot-1', 'morph-accent', 'morph-ring', 'morph-core', 'glow-blob', 'SVG_bg_0']);
  });

  it('only reports informational notes', () => {
    expect(result.warnings.every((w) => w.severity === 'info')).toBe(true);
    expect(result.warnings.map((w) => w.code).sort()).toEqual(['blur-effect', 'trivial-clip']);
  });

  it('maps CSS transform keyframes to anchor/position/rotation/scale, replacing the transform attribute', () => {
    const tr = layer('morph-core').shapes[0].it.at(-1);
    expect(tr.a).toEqual({ a: 0, k: [90, 90] });
    expect(tr.p).toEqual({ a: 0, k: [256, 256] });
    expect(tr.r.a).toBe(1);
    expect(tr.r.k.at(-1).s[0]).toBeCloseTo(180.023, 2); // 3.142rad
    expect(tr.r.k.length).toBe(61); // pre-baked 15fps steps are preserved
  });

  it('keeps per-keyframe cubic-bezier easing for opacity', () => {
    const o = layer('morph-core').shapes[0].it.at(-1).o;
    expect(o.k.map((k: Obj) => [k.t, k.s[0]])).toEqual([[0, 90], [90, 100], [180, 75], [240, 90]]);
    expect(o.k[0].o).toEqual({ x: [0.65], y: [0] });
    expect(o.k[0].i).toEqual({ x: [0.35], y: [1] });
  });

  it('converts SMIL rx splines to rect roundness', () => {
    const rc = find(layer('morph-core').shapes, (o) => o.ty === 'rc')!;
    expect(rc.p.k).toEqual([90, 90]);
    expect(rc.s.k).toEqual([180, 180]);
    expect(rc.r.k.map((k: Obj) => [k.t, k.s[0]])).toEqual([[0, 90], [60, 20], [120, 90], [180, 5], [240, 90]]);
  });

  it('animates stroke width from the border-width keyframes', () => {
    const st = find(layer('morph-ring').shapes, (o) => o.ty === 'st')!;
    expect(st.w.k.map((k: Obj) => k.s[0])).toEqual([3, 6, 2, 3]);
    expect(find(layer('morph-ring').shapes, (o) => o.ty === 'fl')).toBeUndefined();
  });

  it('turns the glow blur into a layer Gaussian blur and moves its transform to the layer', () => {
    const glow = layer('glow-blob');
    expect(glow.ef[0].ty).toBe(29);
    expect(glow.ef[0].ef[0].v.k).toBe(100); // stdDeviation 30 / 0.3
    expect(glow.ks.a.k).toEqual([140, 140, 0]);
    expect(glow.ks.s.a).toBe(1);
    expect(glow.ks.o.k.map((k: Obj) => k.s[0])).toEqual([15, 30, 10, 15]);
    const fill = find(glow.shapes, (o) => o.ty === 'fl')!;
    expect(fill.o.k).toBe(15);
  });
});

describe('feature fixtures', () => {
  it('shapes: elliptical rect corners become a path; rect with rx stays a rect', () => {
    const { animation } = convertSvg(load('shapes-static.svg'));
    expect(animation.w).toBe(200);
    const vb = (animation.layers as Obj[]).find((l) => l.ty === 3)!;
    expect(vb.ks.s.k).toEqual([200, 200, 100]);
    expect(find(animation.layers, (o) => o.ty === 'rc' && o.r.k === 4)).toBeDefined();
    expect(find(animation.layers, (o) => o.ty === 'fl' && o.r === 2)).toBeDefined();
    expect(find(animation.layers, (o) => o.ty === 'st' && Array.isArray(o.d))).toBeDefined();
  });

  it('smil: rotate animateTransform uses the rotation centre as anchor', () => {
    const { animation, warnings } = convertSvg(load('smil-animations.svg'));
    expect(warnings.filter((w) => w.severity !== 'info')).toEqual([]);
    const rotating = find(animation.layers, (o) => o.ty === 'tr' && o.r.a === 1)!;
    expect(rotating.a.k).toEqual([140, 50]);
    expect(rotating.r.k.at(-1).s[0]).toBe(360);
    const morph = find(animation.layers, (o) => o.ty === 'sh' && o.ks.a === 1)!;
    expect(morph.ks.k[0].s[0].v).toHaveLength(4);
    const hold = find(animation.layers, (o) => o.ty === 'el' && o.s.a === 1)!;
    expect(hold.s.k[0].h).toBe(1);
  });

  it('css: steps() become hold keyframes and stroke-dashoffset animates the dash offset', () => {
    const { animation } = convertSvg(load('css-keyframes.svg'));
    const dash = find(animation.layers, (o) => o.ty === 'st' && Array.isArray(o.d))!;
    expect(dash.d.at(-1).v.a).toBe(1);
    const stepper = (animation.layers as Obj[]).find((l) => l.nm === 'stepper')!;
    const p = stepper.shapes[0].it.at(-1).p;
    expect(p.k.filter((k: Obj) => k.h === 1).length).toBeGreaterThanOrEqual(4);
  });

  it('gradients: objectBoundingBox gradients follow animated geometry', () => {
    const { animation } = convertSvg(load('gradients.svg'));
    const radial = find(animation.layers, (o) => o.ty === 'gf' && o.t === 2)!;
    expect(radial.e.a).toBe(1);
    const withAlpha = find(animation.layers, (o) => o.ty === 'gf' && o.g.p === 3)!;
    expect(withAlpha.g.k.k).toHaveLength(3 * 4 + 3 * 2);
    expect(find(animation.layers, (o) => o.ty === 'gs')).toBeDefined();
  });

  it('clip + nested blur: precomp layer with a mask, blurred child layer inside', () => {
    const { animation } = convertSvg(load('clip-and-blur.svg'));
    const pre = (animation.layers as Obj[]).find((l) => l.ty === 0)!;
    expect(pre.hasMask).toBe(true);
    expect(pre.masksProperties).toHaveLength(1);
    const asset = animation.assets.find((a: Obj) => a.id === pre.refId);
    expect(asset.layers.some((l: Obj) => l.ef?.[0]?.ty === 29)).toBe(true);
  });

  it('unsupported features are reported, not silently dropped', () => {
    const { warnings } = convertSvg(load('unsupported.svg'));
    const codes = new Set(warnings.map((w) => w.code));
    for (const c of ['font-missing', 'unsupported-image', 'mask', 'paint-server', 'filter', 'unsupported-animateMotion']) expect(codes).toContain(c);
  });
});

describe('errors and edge cases', () => {
  it('throws on non-SVG input', () => {
    expect(() => convertSvg('<html></html>')).toThrow(/not <svg>/);
    expect(() => convertSvg('not xml')).toThrow();
  });

  it('reports empty documents', () => {
    const { warnings } = convertSvg('<svg viewBox="0 0 10 10"></svg>');
    expect(warnings.some((w) => w.code === 'empty' && w.severity === 'error')).toBe(true);
  });

  it('respects fps and precision options', () => {
    const svg = '<svg viewBox="0 0 10 10"><rect width="3.14159" height="1"><animate attributeName="width" values="1;2" dur="1s" repeatCount="indefinite"/></rect></svg>';
    const { animation } = convertSvg(svg, { fps: 30, precision: 1 });
    expect(animation.fr).toBe(30);
    expect(animation.op).toBe(30);
  });

  it('inherits animated fill from a parent group', () => {
    const svg = '<svg viewBox="0 0 10 10"><style>@keyframes c { to { fill: blue } } g { animation: c 1s infinite }</style><g fill="red"><rect width="5" height="5"/></g></svg>';
    const { animation } = convertSvg(svg);
    const fill = find(animation.layers, (o) => o.ty === 'fl')!;
    expect(fill.c.a).toBe(1);
  });
});

describe('dotLottie', () => {
  it('round-trips the animation and writes a manifest', () => {
    const { animation } = convertSvg(load('figma-motion-sample.svg'));
    const bytes = toDotLottie(animation, { id: 'figma sample' });
    expect(bytes[0]).toBe(0x50); // "PK"
    const back = fromDotLottie(bytes);
    expect(back.manifest).toMatchObject({ version: '1', animations: [{ id: 'figma_sample' }] });
    expect(back.animation).toEqual(animation);
  });
});
