import type { BezierPath, PathData, Vec2 } from './types.js';
import { apply, applyVector, type Matrix } from './matrix.js';

/** Kappa for approximating a quarter circle with a cubic bezier. */
export const KAPPA = 0.5522847498;

interface Builder {
  paths: PathData;
  cur: BezierPath | null;
}

function startPath(b: Builder, p: Vec2): void {
  finishPath(b);
  b.cur = { v: [[p[0], p[1]]], i: [[0, 0]], o: [[0, 0]], c: false };
}

function finishPath(b: Builder): void {
  if (b.cur && b.cur.v.length) b.paths.push(b.cur);
  b.cur = null;
}

function cubicTo(b: Builder, c1: Vec2, c2: Vec2, p: Vec2): void {
  const path = b.cur!;
  const last = path.v.length - 1;
  const lv = path.v[last];
  path.o[last] = [c1[0] - lv[0], c1[1] - lv[1]];
  path.v.push([p[0], p[1]]);
  path.i.push([c2[0] - p[0], c2[1] - p[1]]);
  path.o.push([0, 0]);
}

function lineTo(b: Builder, p: Vec2): void {
  const path = b.cur!;
  const lv = path.v[path.v.length - 1];
  cubicTo(b, lv, p, p);
  path.o[path.v.length - 2] = [0, 0];
}

function closePath(b: Builder): void {
  const path = b.cur;
  if (!path) return;
  path.c = true;
  const n = path.v.length;
  if (n > 1) {
    const first = path.v[0];
    const last = path.v[n - 1];
    if (Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6) {
      path.i[0] = path.i[n - 1];
      path.v.pop();
      path.i.pop();
      path.o.pop();
    }
  }
}

const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;

function tokenize(d: string): (string | number)[] {
  const out: (string | number)[] = [];
  let i = 0;
  let inArc = false;
  let argIndex = 0;
  while (i < d.length) {
    const ch = d[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      out.push(ch);
      inArc = ch === 'A' || ch === 'a';
      argIndex = 0;
      i++;
    } else if (/[\s,]/.test(ch)) {
      i++;
    } else if (inArc && (argIndex % 7 === 3 || argIndex % 7 === 4) && (ch === '0' || ch === '1')) {
      out.push(ch === '1' ? 1 : 0);
      argIndex++;
      i++;
    } else {
      if (inArc) argIndex++;
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(d);
      if (!m) throw new Error(`Invalid path data near "${d.slice(i, i + 10)}"`);
      out.push(parseFloat(m[0]));
      i = NUM_RE.lastIndex;
    }
  }
  return out;
}

function arcToCubics(p0: Vec2, rx: number, ry: number, phiDeg: number, large: number, sweep: number, p: Vec2): [Vec2, Vec2, Vec2][] {
  if (rx === 0 || ry === 0) return [[p0, p, p]];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0[0] - p[0]) / 2;
  const dy = (p0[1] - p[1]) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (p0[0] + p[0]) / 2;
  const cy = sin * cxp + cos * cyp + (p0[1] + p[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2) - 1e-9));
  const delta = dtheta / segs;
  const t = (4 / 3) * Math.tan(delta / 4);
  const out: [Vec2, Vec2, Vec2][] = [];
  const point = (th: number): Vec2 => [cx + rx * Math.cos(th) * cos - ry * Math.sin(th) * sin, cy + rx * Math.cos(th) * sin + ry * Math.sin(th) * cos];
  const deriv = (th: number): Vec2 => [-rx * Math.sin(th) * cos - ry * Math.cos(th) * sin, -rx * Math.sin(th) * sin + ry * Math.cos(th) * cos];
  let th = theta1;
  for (let s = 0; s < segs; s++) {
    const a = point(th);
    const da = deriv(th);
    const th2 = th + delta;
    const b = s === segs - 1 ? p : point(th2);
    const db = deriv(th2);
    out.push([
      [a[0] + t * da[0], a[1] + t * da[1]],
      [b[0] - t * db[0], b[1] - t * db[1]],
      b,
    ]);
    th = th2;
  }
  return out;
}

export function parsePathData(d: string): PathData {
  const tokens = tokenize(d);
  const b: Builder = { paths: [], cur: null };
  let idx = 0;
  let cmd = '';
  let cur: Vec2 = [0, 0];
  let start: Vec2 = [0, 0];
  let lastCtrl: Vec2 | null = null;
  let lastQuad: Vec2 | null = null;
  const num = () => {
    const t = tokens[idx++];
    if (typeof t !== 'number') throw new Error('Invalid path data: expected number');
    return t;
  };
  const ensure = () => {
    if (!b.cur) startPath(b, cur);
  };
  while (idx < tokens.length) {
    const t = tokens[idx];
    if (typeof t === 'string') {
      cmd = t;
      idx++;
    } else if (!cmd) {
      throw new Error('Invalid path data: must start with a command');
    }
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const rp = (x: number, y: number): Vec2 => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    let nextCtrl: Vec2 | null = null;
    let nextQuad: Vec2 | null = null;
    switch (C) {
      case 'M': {
        const p = rp(num(), num());
        startPath(b, p);
        cur = start = p;
        cmd = rel ? 'l' : 'L';
        break;
      }
      case 'L': {
        ensure();
        const p = rp(num(), num());
        lineTo(b, p);
        cur = p;
        break;
      }
      case 'H': {
        ensure();
        const x = num();
        const p: Vec2 = [rel ? cur[0] + x : x, cur[1]];
        lineTo(b, p);
        cur = p;
        break;
      }
      case 'V': {
        ensure();
        const y = num();
        const p: Vec2 = [cur[0], rel ? cur[1] + y : y];
        lineTo(b, p);
        cur = p;
        break;
      }
      case 'C': {
        ensure();
        const c1 = rp(num(), num());
        const c2 = rp(num(), num());
        const p = rp(num(), num());
        cubicTo(b, c1, c2, p);
        nextCtrl = c2;
        cur = p;
        break;
      }
      case 'S': {
        ensure();
        const c1: Vec2 = lastCtrl ? [2 * cur[0] - lastCtrl[0], 2 * cur[1] - lastCtrl[1]] : cur;
        const c2 = rp(num(), num());
        const p = rp(num(), num());
        cubicTo(b, c1, c2, p);
        nextCtrl = c2;
        cur = p;
        break;
      }
      case 'Q':
      case 'T': {
        ensure();
        const q: Vec2 = C === 'Q' ? rp(num(), num()) : lastQuad ? [2 * cur[0] - lastQuad[0], 2 * cur[1] - lastQuad[1]] : cur;
        const p = rp(num(), num());
        const c1: Vec2 = [cur[0] + (2 / 3) * (q[0] - cur[0]), cur[1] + (2 / 3) * (q[1] - cur[1])];
        const c2: Vec2 = [p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1])];
        cubicTo(b, c1, c2, p);
        nextQuad = q;
        cur = p;
        break;
      }
      case 'A': {
        ensure();
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num() ? 1 : 0;
        const sweep = num() ? 1 : 0;
        const p = rp(num(), num());
        for (const [c1, c2, e] of arcToCubics(cur, rx, ry, rot, large, sweep, p)) cubicTo(b, c1, c2, e);
        cur = p;
        break;
      }
      case 'Z': {
        closePath(b);
        finishPath(b);
        cur = start;
        break;
      }
      default:
        throw new Error(`Unsupported path command ${cmd}`);
    }
    lastCtrl = nextCtrl;
    lastQuad = nextQuad;
  }
  finishPath(b);
  return b.paths;
}

export function rectPath(x: number, y: number, w: number, h: number, rx = 0, ry = 0): BezierPath {
  rx = Math.min(Math.max(0, rx), w / 2);
  ry = Math.min(Math.max(0, ry), h / 2);
  if (rx === 0 || ry === 0) {
    return { v: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], i: [[0, 0], [0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0], [0, 0]], c: true };
  }
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    v: [
      [x + rx, y], [x + w - rx, y], [x + w, y + ry], [x + w, y + h - ry],
      [x + w - rx, y + h], [x + rx, y + h], [x, y + h - ry], [x, y + ry],
    ],
    i: [[-kx, 0], [0, 0], [0, -ky], [0, 0], [kx, 0], [0, 0], [0, ky], [0, 0]],
    o: [[0, 0], [kx, 0], [0, 0], [0, ky], [0, 0], [-kx, 0], [0, 0], [0, -ky]],
    c: true,
  };
}

export function ellipsePath(cx: number, cy: number, rx: number, ry: number): BezierPath {
  const kx = rx * KAPPA;
  const ky = ry * KAPPA;
  return {
    v: [[cx + rx, cy], [cx, cy + ry], [cx - rx, cy], [cx, cy - ry]],
    i: [[0, -ky], [kx, 0], [0, ky], [-kx, 0]],
    o: [[0, ky], [-kx, 0], [0, -ky], [kx, 0]],
    c: true,
  };
}

export function polyPath(points: number[], closed: boolean): BezierPath {
  const v: Vec2[] = [];
  for (let k = 0; k + 1 < points.length; k += 2) v.push([points[k], points[k + 1]]);
  return { v, i: v.map(() => [0, 0] as Vec2), o: v.map(() => [0, 0] as Vec2), c: closed };
}

export function parsePoints(s: string): number[] {
  return (s.match(/[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
}

export function transformPath(path: PathData, m: Matrix): PathData {
  return path.map((p) => ({
    v: p.v.map((v) => apply(m, v)),
    i: p.i.map((v) => applyVector(m, v)),
    o: p.o.map((v) => applyVector(m, v)),
    c: p.c,
  }));
}

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Tight bounding box of a cubic path (evaluates segment extrema). */
export function pathBBox(path: PathData): BBox {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const p of path) {
    const n = p.v.length;
    const segs = p.c ? n : n - 1;
    for (let k = 0; k < n; k++) add(p.v[k][0], p.v[k][1]);
    for (let k = 0; k < segs; k++) {
      const a = p.v[k];
      const b = p.v[(k + 1) % n];
      const c1: Vec2 = [a[0] + p.o[k][0], a[1] + p.o[k][1]];
      const c2: Vec2 = [b[0] + p.i[(k + 1) % n][0], b[1] + p.i[(k + 1) % n][1]];
      for (let s = 1; s < 16; s++) {
        const t = s / 16;
        const mt = 1 - t;
        const f = (i: 0 | 1) => mt * mt * mt * a[i] + 3 * mt * mt * t * c1[i] + 3 * mt * t * t * c2[i] + t * t * t * b[i];
        add(f(0), f(1));
      }
    }
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, width: 0, height: 0 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function sameTopology(a: PathData, b: PathData): boolean {
  return a.length === b.length && a.every((p, k) => p.v.length === b[k].v.length && p.c === b[k].c);
}
