import type { Bezier, Ease } from './types.js';
import { LINEAR } from './types.js';

const KEYWORDS: Record<string, Bezier> = {
  linear: LINEAR,
  ease: { x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 },
  'ease-in': { x1: 0.42, y1: 0, x2: 1, y2: 1 },
  'ease-out': { x1: 0, y1: 0, x2: 0.58, y2: 1 },
  'ease-in-out': { x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
};

/**
 * A parsed CSS timing function. `stops` (for `linear()` with intermediate points and `steps()`) are
 * expanded into extra keyframes by the timeline.
 */
export type TimingFunction =
  | { kind: 'bezier'; bezier: Bezier }
  | { kind: 'linear-points'; points: { input: number; output: number }[] }
  | { kind: 'steps'; count: number; position: 'start' | 'end' | 'none' | 'both' };

export function parseTimingFunction(input: string): TimingFunction | null {
  const s = input.trim().toLowerCase();
  if (KEYWORDS[s]) return { kind: 'bezier', bezier: KEYWORDS[s] };
  if (s === 'step-start') return { kind: 'steps', count: 1, position: 'start' };
  if (s === 'step-end') return { kind: 'steps', count: 1, position: 'end' };
  let m = /^cubic-bezier\(([^)]*)\)$/.exec(s);
  if (m) {
    const n = m[1].split(/[\s,]+/).filter(Boolean).map(Number);
    if (n.length === 4 && n.every(Number.isFinite)) return { kind: 'bezier', bezier: { x1: n[0], y1: n[1], x2: n[2], y2: n[3] } };
    return null;
  }
  m = /^steps\(([^)]*)\)$/.exec(s);
  if (m) {
    const [count, pos = 'end'] = m[1].split(',').map((p) => p.trim());
    const map: Record<string, 'start' | 'end' | 'none' | 'both'> = {
      start: 'start', 'jump-start': 'start', end: 'end', 'jump-end': 'end', 'jump-none': 'none', 'jump-both': 'both',
    };
    return { kind: 'steps', count: Math.max(1, parseInt(count, 10) || 1), position: map[pos] ?? 'end' };
  }
  m = /^linear\((.*)\)$/.exec(s);
  if (m) return parseLinearFunction(m[1]);
  return null;
}

function parseLinearFunction(body: string): TimingFunction | null {
  const raw: { output: number; inputs: number[] }[] = [];
  for (const part of body.split(',')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const output = parseFloat(tokens[0]);
    if (!Number.isFinite(output)) return null;
    raw.push({ output, inputs: tokens.slice(1).map((t) => parseFloat(t) / 100) });
  }
  if (raw.length < 2) return null;
  const points: { input: number; output: number }[] = [];
  for (const r of raw) {
    if (r.inputs.length === 0) points.push({ input: NaN, output: r.output });
    else for (const i of r.inputs) points.push({ input: i, output: r.output });
  }
  if (Number.isNaN(points[0].input)) points[0].input = 0;
  const last = points[points.length - 1];
  if (Number.isNaN(last.input)) last.input = Math.max(1, ...points.filter((p) => !Number.isNaN(p.input)).map((p) => p.input));
  // Monotonic inputs, then distribute missing inputs evenly between known ones.
  let maxSoFar = points[0].input;
  for (const p of points) if (!Number.isNaN(p.input)) p.input = maxSoFar = Math.max(maxSoFar, p.input);
  for (let i = 1; i < points.length; i++) {
    if (!Number.isNaN(points[i].input)) continue;
    let j = i;
    while (Number.isNaN(points[j].input)) j++;
    const a = points[i - 1].input;
    const b = points[j].input;
    for (let k = i; k < j; k++) points[k].input = a + ((b - a) * (k - i + 1)) / (j - i + 1);
  }
  return { kind: 'linear-points', points };
}

/** Evaluate a cubic-bezier easing: progress x → eased y. */
export function evalBezier(b: Bezier, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (b.x1 === b.y1 && b.x2 === b.y2) return x;
  const cx = 3 * b.x1;
  const bx = 3 * (b.x2 - b.x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * b.y1;
  const by = 3 * (b.y2 - b.y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 8; i++) {
    const err = sampleX(t) - x;
    if (Math.abs(err) < 1e-7) return sampleY(t);
    const d = slopeX(t);
    if (Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  let lo = 0;
  let hi = 1;
  t = x;
  for (let i = 0; i < 40; i++) {
    const v = sampleX(t);
    if (Math.abs(v - x) < 1e-7) break;
    if (v < x) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return sampleY(t);
}

export function evalEase(e: Ease, x: number): number {
  if (e === 'hold') return x >= 1 ? 1 : 0;
  return evalBezier(e, x);
}

/**
 * Split an easing segment at progress `x`. Returns the eased value there plus the normalized easings of
 * the left and right sub-segments, so a keyframe can be inserted without changing the motion.
 */
export function splitEase(e: Ease, x: number): { y: number; left: Ease; right: Ease } {
  if (e === 'hold') return { y: 0, left: 'hold', right: 'hold' };
  const { x1, y1, x2, y2 } = e;
  const bx = (s: number) => 3 * (1 - s) * (1 - s) * s * x1 + 3 * (1 - s) * s * s * x2 + s * s * s;
  let lo = 0;
  let hi = 1;
  let s = x;
  for (let k = 0; k < 60; k++) {
    s = (lo + hi) / 2;
    if (bx(s) < x) lo = s;
    else hi = s;
  }
  const lerp = (a: [number, number], b: [number, number]): [number, number] => [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s];
  const p0: [number, number] = [0, 0];
  const p1: [number, number] = [x1, y1];
  const p2: [number, number] = [x2, y2];
  const p3: [number, number] = [1, 1];
  const a = lerp(p0, p1);
  const b = lerp(p1, p2);
  const c = lerp(p2, p3);
  const d = lerp(a, b);
  const f = lerp(b, c);
  const m = lerp(d, f);
  const norm = (q0: [number, number], q1: [number, number], q2: [number, number], q3: [number, number]): Ease => {
    const w = q3[0] - q0[0];
    const h = q3[1] - q0[1];
    if (Math.abs(w) < 1e-9 || Math.abs(h) < 1e-9) return LINEAR;
    return { x1: (q1[0] - q0[0]) / w, y1: (q1[1] - q0[1]) / h, x2: (q2[0] - q0[0]) / w, y2: (q2[1] - q0[1]) / h };
  };
  return { y: m[1], left: norm(p0, a, d, m), right: norm(m, f, c, p3) };
}

export function reverseEase(e: Ease): Ease {
  if (e === 'hold') return e;
  return { x1: 1 - e.x2, y1: 1 - e.y2, x2: 1 - e.x1, y2: 1 - e.y1 };
}
