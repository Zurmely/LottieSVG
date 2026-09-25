import { describe, expect, it } from 'vitest';
import { parseColor } from '../src/color.js';
import { parseAnimationShorthand, parseSelector, matchSelector, parseStylesheet, resolveAnimations } from '../src/css.js';
import { evalBezier, parseTimingFunction, splitEase } from '../src/easing.js';
import { apply } from '../src/matrix.js';
import { parsePathData, pathBBox } from '../src/path.js';
import { computeDuration, unrollAnimation, lerpNumber } from '../src/timeline.js';
import { componentsToMatrix, decompose, opsToMatrix, parseTransformList, toComponents } from '../src/transform.js';
import type { PropAnimation } from '../src/document.js';
import { WarningCollector } from '../src/warnings.js';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('parseColor', () => {
  it('parses hex, short hex, rgba, hsl and names', () => {
    expect(parseColor('#5A50DC')).toEqual([0x5a / 255, 0x50 / 255, 0xdc / 255, 1]);
    expect(parseColor('#fff')).toEqual([1, 1, 1, 1]);
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual([1, 0, 0, 0.5]);
    expect(parseColor('rgb(0 128 255 / 50%)')?.[3]).toBe(0.5);
    const hsl = parseColor('hsl(120, 100%, 50%)')!;
    close(hsl[1], 1);
    close(hsl[0], 0);
    expect(parseColor('teal')).toEqual([0, 128 / 255, 128 / 255, 1]);
    expect(parseColor('none')).toBeNull();
    expect(parseColor('url(#g)')).toBeNull();
  });
});

describe('parsePathData', () => {
  it('converts lines and closes paths, merging a duplicate end vertex', () => {
    const [p] = parsePathData('M0 0 L10 0 L10 10 L0 0 Z');
    expect(p.c).toBe(true);
    expect(p.v).toEqual([[0, 0], [10, 0], [10, 10]]);
  });

  it('handles relative commands, H/V and implicit lineto after M', () => {
    const [p] = parsePathData('m5 5 10 0 v10 h-10 z');
    expect(p.v).toEqual([[5, 5], [15, 5], [15, 15], [5, 15]]);
  });

  it('converts quadratic and smooth cubic curves', () => {
    const [q] = parsePathData('M0 0 Q 10 10 20 0');
    expect(q.o[0][0]).toBeCloseTo(20 / 3);
    expect(q.o[0][1]).toBeCloseTo(20 / 3);
    const [s] = parsePathData('M0 0 C 0 10 10 10 10 0 S 20 -10 20 0');
    // reflected control point of the second segment
    expect(s.o[1][0]).toBeCloseTo(0);
    expect(s.o[1][1]).toBeCloseTo(-10);
  });

  it('parses arcs including compact flags', () => {
    const a = parsePathData('M0 0 a10 10 0 01 20 0');
    const b = parsePathData('M0 0 A10 10 0 0 1 20 0');
    expect(a).toEqual(b);
    const bb = pathBBox(a);
    close(bb.y, -10, 1e-3);
    close(bb.width, 20, 1e-6);
  });

  it('supports multiple subpaths and exponent numbers', () => {
    const paths = parsePathData('M0,0L1e1,0ZM-5.5.5l1-1');
    expect(paths).toHaveLength(2);
    expect(paths[1].v).toEqual([[-5.5, 0.5], [-4.5, -0.5]]);
  });

  it('rejects garbage', () => {
    expect(() => parsePathData('M0 0 X 10')).toThrow();
  });
});

describe('transforms', () => {
  it('parses SVG attribute syntax with rotate centre', () => {
    const { ops } = parseTransformList('translate(10,20) rotate(90 5 5)');
    const m = opsToMatrix(ops);
    const p = apply(m, [5, 0]);
    close(p[0], 20);
    close(p[1], 25);
  });

  it('maps the Figma Motion pattern exactly, keeping rotations beyond 180°', () => {
    const { ops } = parseTransformList('translateX(166px) translateY(166px) translate(90px, 90px) rotate(4.712rad) scaleX(1.15) scaleY(0.9) translate(-90px, -90px)');
    const { components, exact } = toComponents(ops);
    expect(exact).toBe(true);
    expect(components.anchor).toEqual([90, 90]);
    expect(components.position).toEqual([256, 256]);
    close(components.rotation, (4.712 * 180) / Math.PI);
    close(components.scale[0], 115);
    close(components.scale[1], 90);
  });

  it('decomposes arbitrary matrices including skew and round-trips', () => {
    const { ops } = parseTransformList('translate(3 4) rotate(30) skewX(20) scale(2 0.5)');
    const m = opsToMatrix(ops);
    const tc = decompose(m, [1, 2]);
    const back = componentsToMatrix(tc);
    back.forEach((v, k) => close(v, m[k], 1e-9));
  });

  it('falls back to decomposition for non-uniform scale before rotation', () => {
    const { ops } = parseTransformList('scale(2 1) rotate(45)');
    const { components, exact } = toComponents(ops);
    expect(exact).toBe(false);
    const back = componentsToMatrix(components);
    opsToMatrix(ops).forEach((v, k) => close(v, back[k], 1e-9));
  });

  it('unwraps decomposed rotations relative to the previous keyframe', () => {
    const tc = decompose(opsToMatrix(parseTransformList('rotate(350) skewX(1)').ops), [0, 0], 340);
    close(tc.rotation, 350, 1e-6);
  });

  it('reports unsupported functions', () => {
    expect(parseTransformList('translateZ(10px) perspective(100px)').issues).toHaveLength(2);
  });
});

describe('easing', () => {
  it('parses keywords, cubic-bezier, steps and linear()', () => {
    expect(parseTimingFunction('ease-in-out')).toEqual({ kind: 'bezier', bezier: { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } });
    expect(parseTimingFunction('cubic-bezier(0.65, 0, 0.35, 1)')).toEqual({ kind: 'bezier', bezier: { x1: 0.65, y1: 0, x2: 0.35, y2: 1 } });
    expect(parseTimingFunction('steps(4, jump-start)')).toEqual({ kind: 'steps', count: 4, position: 'start' });
    const lin = parseTimingFunction('linear(0, 0.8 40%, 1)');
    expect(lin).toEqual({ kind: 'linear-points', points: [{ input: 0, output: 0 }, { input: 0.4, output: 0.8 }, { input: 1, output: 1 }] });
  });

  it('evaluates beziers', () => {
    close(evalBezier({ x1: 0, y1: 0, x2: 1, y2: 1 }, 0.3), 0.3);
    close(evalBezier({ x1: 0.42, y1: 0, x2: 0.58, y2: 1 }, 0.5), 0.5, 1e-5);
  });

  it('splits an easing without changing the curve', () => {
    const e = { x1: 0.65, y1: 0, x2: 0.35, y2: 1 };
    const { y, left, right } = splitEase(e, 0.3);
    close(y, evalBezier(e, 0.3), 1e-5);
    // a point inside the right half maps consistently
    const x = 0.6;
    const expected = evalBezier(e, x);
    const viaRight = y + (1 - y) * evalBezier(right as never, (x - 0.3) / 0.7);
    close(viaRight, expected, 1e-4);
    const viaLeft = y * evalBezier(left as never, 0.1 / 0.3);
    close(viaLeft, evalBezier(e, 0.1), 1e-4);
  });
});

describe('css', () => {
  it('parses the animation shorthand list', () => {
    const [a, b] = parseAnimationShorthand('kf_a 4s linear infinite, kf_b 2s cubic-bezier(0.1, 0.2, 0.3, 1) 0.5s 3 alternate both');
    expect(a).toMatchObject({ name: 'kf_a', duration: 4, timingFunction: 'linear', iterationCount: Infinity });
    expect(b).toMatchObject({ name: 'kf_b', duration: 2, delay: 0.5, iterationCount: 3, direction: 'alternate', fillMode: 'both' });
  });

  it('applies longhands over the shorthand', () => {
    const specs = resolveAnimations(new Map([['animation', 'spin 1s'], ['animation-iteration-count', 'infinite'], ['animation-delay', '200ms']]));
    expect(specs[0]).toMatchObject({ name: 'spin', iterationCount: Infinity, delay: 0.2 });
  });

  it('matches compound and descendant selectors', () => {
    const el = (tag: string, attrs: Record<string, string>, parent: never | null = null) => ({ tagName: tag, parent, getAttribute: (n: string) => attrs[n] ?? null });
    const g = el('g', { id: 'root' });
    const r = el('rect', { class: 'a b' }, g as never);
    expect(matchSelector(parseSelector('#root rect.a')!, r)).toBe(true);
    expect(matchSelector(parseSelector('g > .b')!, r)).toBe(true);
    expect(matchSelector(parseSelector('circle')!, r)).toBe(false);
    expect(parseSelector('rect:hover')).toBeNull();
  });

  it('parses @keyframes with comma offsets', () => {
    const sheet = parseStylesheet('@keyframes k { 0%, 100% { opacity: 1 } 50% { opacity: 0 } } #a { fill: red }', new WarningCollector());
    expect(sheet.keyframes.get('k')?.[0].offsets).toEqual([0, 1]);
    expect(sheet.rules[0].declarations[0]).toMatchObject({ property: 'fill', value: 'red' });
  });
});

describe('timeline', () => {
  const ctx = (duration: number) => ({ duration, fps: 60, warnings: new WarningCollector() });
  const anim = (over: Partial<PropAnimation>): PropAnimation => ({
    source: 'css',
    property: 'opacity',
    keyframes: [
      { offset: 0, value: '0', timing: { kind: 'bezier', bezier: { x1: 0, y1: 0, x2: 1, y2: 1 } } },
      { offset: 1, value: '1', timing: { kind: 'bezier', bezier: { x1: 0, y1: 0, x2: 1, y2: 1 } } },
    ],
    duration: 1,
    delay: 0,
    iterations: Infinity,
    direction: 'normal',
    fillForwards: false,
    fillBackwards: false,
    additive: false,
    label: 'test',
    ...over,
  });
  const opts = { parse: (s: string) => parseFloat(s), base: 0.5, interp: lerpNumber, label: 'x', property: 'opacity' };

  it('computes the LCM of loop durations', () => {
    const w = new WarningCollector();
    expect(computeDuration([anim({ duration: 2 }), anim({ duration: 3 })], 60, 30, w)).toBe(6);
    expect(computeDuration([anim({ duration: 1, direction: 'alternate' })], 60, 30, w)).toBe(2);
    expect(computeDuration([anim({ duration: 7 }), anim({ duration: 11 })], 60, 30, w)).toBe(11);
    expect(w.list[0].code).toBe('loop-mismatch');
  });

  it('unrolls looping animations with a jump at each seam', () => {
    const kfs = unrollAnimation(anim({}), opts, ctx(2))!;
    expect(kfs.map((k) => [Number(k.t.toFixed(3)), k.v])).toEqual([[0, 0], [0.999, 1], [1, 0], [2, 1]]);
    expect(kfs[1].ease).toBe('hold');
  });

  it('alternates direction without duplicate keyframes', () => {
    const kfs = unrollAnimation(anim({ direction: 'alternate' }), opts, ctx(2))!;
    expect(kfs.map((k) => [k.t, k.v])).toEqual([[0, 0], [1, 1], [2, 0]]);
  });

  it('holds the base value during a finite delay and after the end unless filled', () => {
    const kfs = unrollAnimation(anim({ iterations: 1, delay: 0.5 }), opts, ctx(2))!;
    expect(kfs.map((k) => [Number(k.t.toFixed(3)), k.v])).toEqual([[0, 0.5], [0.5, 0], [1.499, 1], [1.5, 0.5]]);
    const frozen = unrollAnimation(anim({ iterations: 1, delay: 0.5, fillForwards: true, fillBackwards: true }), opts, ctx(2))!;
    expect(frozen.map((k) => [k.t, k.v])).toEqual([[0, 0], [0.5, 0], [1.5, 1]]);
  });

  it('shifts looping animations with a delay into their steady-state loop', () => {
    const kfs = unrollAnimation(anim({ delay: 0.25 }), opts, ctx(1))!;
    expect(kfs[0].t).toBe(0);
    close(kfs[0].v, 0.75, 1e-3);
  });

  it('truncates partial final iterations', () => {
    const kfs = unrollAnimation(anim({ iterations: 1.5, fillForwards: true }), opts, ctx(2))!;
    const last = kfs[kfs.length - 1];
    close(last.t, 1.5);
    close(last.v, 0.5);
  });

  it('adds implicit 0%/100% keyframes from the base value', () => {
    const kfs = unrollAnimation(anim({ iterations: 1, implicitEnds: true, keyframes: [{ offset: 1, value: '1', timing: { kind: 'bezier', bezier: { x1: 0, y1: 0, x2: 1, y2: 1 } } }] }), opts, ctx(1))!;
    expect(kfs[0].v).toBe(0.5);
  });
});
