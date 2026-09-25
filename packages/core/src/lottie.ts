import type { Animatable, BezierPath, TransformComponents, Value } from './types.js';
import { isAnimated } from './timeline.js';

export interface EmitContext {
  fps: number;
  animatedProperties: number;
  keyframes: number;
}

/** Seconds → frames, snapping near-integers (e.g. Figma's rounded 1.67% offsets) unless that would collide. */
function toFrame(t: number, fps: number, previous: number): number {
  const f = t * fps;
  const r = Math.round(f);
  if (Math.abs(f - r) < 0.02 && r > previous) return r;
  return Math.round(f * 1000) / 1000;
}

type Scalarish = number | number[] | Record<string, unknown>;

/** Emit a Lottie animatable property `{a, k}`. `map` converts internal values to Lottie values. */
export function prop<T extends Value>(value: Animatable<T>, map: (v: T) => Scalarish, ctx: EmitContext): { a: 0 | 1; k: unknown } {
  if (!isAnimated(value)) return { a: 0, k: map(value.static) };
  const kfs = value.track.keyframes;
  const first = JSON.stringify(map(kfs[0].v));
  if (kfs.every((k) => JSON.stringify(map(k.v)) === first)) return { a: 0, k: map(kfs[0].v) };
  const out: Record<string, unknown>[] = [];
  let lastFrame = -Infinity;
  for (let i = 0; i < kfs.length; i++) {
    const kf = kfs[i];
    const t = toFrame(kf.t, ctx.fps, lastFrame);
    const mapped = map(kf.v);
    const s = typeof mapped === 'number' ? [mapped] : Array.isArray(mapped) ? mapped : [mapped];
    const entry: Record<string, unknown> = { t, s };
    if (i < kfs.length - 1) {
      if (kf.ease === 'hold') entry.h = 1;
      else {
        entry.o = { x: [kf.ease.x1], y: [kf.ease.y1] };
        entry.i = { x: [kf.ease.x2], y: [kf.ease.y2] };
      }
    }
    if (t <= lastFrame) out.pop();
    out.push(entry);
    lastFrame = t;
  }
  if (out.length === 1) return { a: 0, k: map(kfs[0].v) };
  ctx.animatedProperties++;
  ctx.keyframes += out.length;
  return { a: 1, k: out };
}

export const num = (v: number) => v;
export const identityArr = (v: number[]) => v;

export function shapeValue(p: BezierPath): Record<string, unknown> {
  return { i: p.i, o: p.o, v: p.v, c: p.c };
}

export function staticProp(k: unknown): { a: 0; k: unknown } {
  return { a: 0, k };
}

export function shapeTransform(tc: Animatable<TransformComponents>, opacity: Animatable<number>, ctx: EmitContext): Record<string, unknown> {
  const tr: Record<string, unknown> = {
    ty: 'tr',
    p: prop(tc, (v) => v.position, ctx),
    a: prop(tc, (v) => v.anchor, ctx),
    s: prop(tc, (v) => v.scale, ctx),
    r: prop(tc, (v) => v.rotation, ctx),
    o: prop(opacity, (v) => v * 100, ctx),
    sk: prop(tc, (v) => v.skew, ctx),
    sa: prop(tc, (v) => v.skewAxis, ctx),
    nm: 'Transform',
  };
  return tr;
}

export function layerTransform(tc: Animatable<TransformComponents>, opacity: Animatable<number>, ctx: EmitContext): Record<string, unknown> {
  const ks: Record<string, unknown> = {
    o: prop(opacity, (v) => v * 100, ctx),
    r: prop(tc, (v) => v.rotation, ctx),
    p: prop(tc, (v) => [v.position[0], v.position[1], 0], ctx),
    a: prop(tc, (v) => [v.anchor[0], v.anchor[1], 0], ctx),
    s: prop(tc, (v) => [v.scale[0], v.scale[1], 100], ctx),
  };
  const sk = prop(tc, (v) => v.skew, ctx);
  if (sk.a === 1 || sk.k !== 0) {
    ks.sk = sk;
    ks.sa = prop(tc, (v) => v.skewAxis, ctx);
  }
  return ks;
}

export function group(name: string, items: unknown[], tr: Record<string, unknown>): Record<string, unknown> {
  return { ty: 'gr', nm: name, it: [...items, tr], np: items.length, cix: 2, bm: 0, hd: false };
}

export function roundDeep<T>(value: T, precision: number): T {
  const f = 10 ** precision;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'number') {
      const r = Math.round(v * f) / f;
      return Object.is(r, -0) ? 0 : r;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) o[k] = walk(val);
      return o;
    }
    return v;
  };
  return walk(value) as T;
}
