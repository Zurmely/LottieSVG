import type { TransformComponents, Vec2 } from './types.js';
import { IDENTITY, apply, multiply, rotate, scale, skewX, skewY, translate, type Matrix } from './matrix.js';

export type TransformOp =
  | { type: 'translate'; x: number; y: number }
  | { type: 'scale'; x: number; y: number }
  | { type: 'rotate'; deg: number }
  | { type: 'skewX'; deg: number }
  | { type: 'skewY'; deg: number }
  | { type: 'matrix'; m: Matrix };

export interface ParsedTransform {
  ops: TransformOp[];
  /** Unsupported pieces (3D functions, percentage lengths…) found while parsing. */
  issues: string[];
}

function splitArgs(s: string): string[] {
  return s.split(/[\s,]+/).filter(Boolean);
}

function parseAngle(s: string, issues: string[]): number {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|turn|grad)?$/i.exec(s.trim());
  if (!m) {
    issues.push(`unparseable angle "${s}"`);
    return 0;
  }
  const n = parseFloat(m[1]);
  switch ((m[2] ?? 'deg').toLowerCase()) {
    case 'rad':
      return (n * 180) / Math.PI;
    case 'turn':
      return n * 360;
    case 'grad':
      return n * 0.9;
    default:
      return n;
  }
}

function parseLength(s: string, issues: string[]): number {
  const t = s.trim();
  if (t.endsWith('%')) issues.push(`percentage length "${t}" in transform treated as px`);
  else if (/[a-z]$/i.test(t) && !t.endsWith('px')) issues.push(`unit in "${t}" treated as px`);
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Parse either an SVG `transform` attribute or a CSS `transform` property value.
 * SVG `rotate(a cx cy)` is expanded to translate/rotate/translate.
 */
export function parseTransformList(input: string | null | undefined): ParsedTransform {
  const ops: TransformOp[] = [];
  const issues: string[] = [];
  if (!input || input.trim() === 'none') return { ops, issues };
  const re = /([a-zA-Z0-9]+)\s*\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    const name = m[1];
    const args = splitArgs(m[2]);
    const len = (k: number, d = 0) => (args[k] !== undefined ? parseLength(args[k], issues) : d);
    const ang = (k: number) => (args[k] !== undefined ? parseAngle(args[k], issues) : 0);
    switch (name) {
      case 'translate':
        ops.push({ type: 'translate', x: len(0), y: len(1) });
        break;
      case 'translateX':
        ops.push({ type: 'translate', x: len(0), y: 0 });
        break;
      case 'translateY':
        ops.push({ type: 'translate', x: 0, y: len(0) });
        break;
      case 'scale': {
        const x = parseFloat(args[0] ?? '1');
        const y = args[1] !== undefined ? parseFloat(args[1]) : x;
        ops.push({ type: 'scale', x, y });
        break;
      }
      case 'scaleX':
        ops.push({ type: 'scale', x: parseFloat(args[0] ?? '1'), y: 1 });
        break;
      case 'scaleY':
        ops.push({ type: 'scale', x: 1, y: parseFloat(args[0] ?? '1') });
        break;
      case 'rotate': {
        const deg = ang(0);
        if (args.length >= 3) {
          const cx = len(1);
          const cy = len(2);
          ops.push({ type: 'translate', x: cx, y: cy }, { type: 'rotate', deg }, { type: 'translate', x: -cx, y: -cy });
        } else ops.push({ type: 'rotate', deg });
        break;
      }
      case 'rotateZ':
        ops.push({ type: 'rotate', deg: ang(0) });
        break;
      case 'skewX':
        ops.push({ type: 'skewX', deg: ang(0) });
        break;
      case 'skewY':
        ops.push({ type: 'skewY', deg: ang(0) });
        break;
      case 'skew':
        ops.push({ type: 'skewX', deg: ang(0) });
        if (args[1] !== undefined) ops.push({ type: 'skewY', deg: ang(1) });
        break;
      case 'matrix': {
        const n = args.map(Number);
        if (n.length === 6 && n.every(Number.isFinite)) ops.push({ type: 'matrix', m: n as Matrix });
        else issues.push(`invalid matrix(${m[2]})`);
        break;
      }
      case 'translateZ':
      case 'scaleZ':
        issues.push(`3D function ${name}() ignored`);
        break;
      default:
        issues.push(`unsupported transform function ${name}()`);
    }
  }
  return { ops, issues };
}

export function opMatrix(op: TransformOp): Matrix {
  switch (op.type) {
    case 'translate':
      return translate(op.x, op.y);
    case 'scale':
      return scale(op.x, op.y);
    case 'rotate':
      return rotate(op.deg);
    case 'skewX':
      return skewX(op.deg);
    case 'skewY':
      return skewY(op.deg);
    case 'matrix':
      return op.m;
  }
}

export function opsToMatrix(ops: TransformOp[]): Matrix {
  return ops.reduce<Matrix>((acc, op) => multiply(acc, opMatrix(op)), IDENTITY);
}

export const IDENTITY_COMPONENTS: TransformComponents = {
  anchor: [0, 0],
  position: [0, 0],
  rotation: 0,
  scale: [100, 100],
  skew: 0,
  skewAxis: 0,
};

/**
 * Convert a transform list to Lottie components. Figma Motion emits
 * `translate… rotate scale translate(-anchor)`; that shape is mapped directly so that rotations beyond
 * ±180° and CSS's function-wise interpolation are preserved. Anything else goes through matrix
 * decomposition, using `prevRotation` to unwrap angles between keyframes.
 */
export function toComponents(ops: TransformOp[], prevRotation?: number): { components: TransformComponents; exact: boolean } {
  let start = 0;
  let end = ops.length;
  const pos: Vec2 = [0, 0];
  const anchor: Vec2 = [0, 0];
  while (start < end && ops[start].type === 'translate') {
    const op = ops[start++] as { x: number; y: number };
    pos[0] += op.x;
    pos[1] += op.y;
  }
  while (end > start && ops[end - 1].type === 'translate') {
    const op = ops[--end] as { x: number; y: number };
    anchor[0] -= op.x;
    anchor[1] -= op.y;
  }
  const core = ops.slice(start, end);
  let rotation = 0;
  let sx = 1;
  let sy = 1;
  let seenScale = false;
  let simple = true;
  for (const op of core) {
    if (op.type === 'rotate') {
      // A rotation after a non-uniform scale would need skew; only allow uniform scales before rotations.
      if (seenScale && Math.abs(sx - sy) > 1e-9) {
        simple = false;
        break;
      }
      rotation += op.deg;
    } else if (op.type === 'scale') {
      seenScale = true;
      sx *= op.x;
      sy *= op.y;
    } else {
      simple = false;
      break;
    }
  }
  if (simple) {
    return {
      components: { anchor, position: pos, rotation, scale: [sx * 100, sy * 100], skew: 0, skewAxis: 0 },
      exact: true,
    };
  }
  return { components: decompose(opsToMatrix(ops), anchor, prevRotation), exact: false };
}

/** Decompose M = T(P)·R(θ)·SkewX(φ)·S(sx, sy)·T(-A) for a given anchor A. */
export function decompose(m: Matrix, anchorPoint: Vec2 = [0, 0], prevRotation?: number): TransformComponents {
  const [a, b, c, d] = m;
  const position = apply(m, anchorPoint);
  let sx = Math.hypot(a, b);
  let theta = Math.atan2(b, a);
  if (sx < 1e-12) {
    sx = 0;
    theta = 0;
  }
  const det = a * d - b * c;
  const mm = sx ? (a * c + b * d) / sx : 0;
  const sy = sx ? det / sx : Math.hypot(c, d);
  const phi = sy ? Math.atan(mm / sy) : 0;
  let rotationDeg = (theta * 180) / Math.PI;
  if (prevRotation !== undefined) {
    while (rotationDeg - prevRotation > 180) rotationDeg -= 360;
    while (rotationDeg - prevRotation < -180) rotationDeg += 360;
  }
  return {
    anchor: [anchorPoint[0], anchorPoint[1]],
    position,
    rotation: rotationDeg,
    scale: [sx * 100, sy * 100],
    skew: (-phi * 180) / Math.PI,
    skewAxis: 0,
  };
}

/** Matrix represented by Lottie transform components. */
export function componentsToMatrix(tc: TransformComponents): Matrix {
  return [
    translate(tc.position[0], tc.position[1]),
    rotate(tc.rotation),
    skewX(-tc.skew),
    scale(tc.scale[0] / 100, tc.scale[1] / 100),
    translate(-tc.anchor[0], -tc.anchor[1]),
  ].reduce<Matrix>((acc, n) => multiply(acc, n), IDENTITY);
}

/** Structural signature, used to detect when CSS would fall back to matrix interpolation. */
export function opsSignature(ops: TransformOp[]): string {
  return ops.map((o) => o.type).join(',');
}
