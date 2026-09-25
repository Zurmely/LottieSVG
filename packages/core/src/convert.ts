import { parseColor, type RGBA } from './color.js';
import { parseSvgDocument, type PropAnimation, type PropState, type SvgDocument, type SvgNode } from './document.js';
import { group, layerTransform, prop, roundDeep, shapeTransform, shapeValue, staticProp, type EmitContext } from './lottie.js';
import { IDENTITY, apply, applyVector, isIdentity, multiply, scale as scaleM, translate as translateM, type Matrix } from './matrix.js';
import {
  ellipsePath,
  parsePathData,
  parsePoints,
  pathBBox,
  polyPath,
  rectPath,
  sameTopology,
  transformPath,
  type BBox,
} from './path.js';
import {
  buildAnimatable,
  combine,
  computeDuration,
  fromKeyframes,
  isAnimated,
  lerpArray,
  lerpNumber,
  mapAnimatable,
  unrollAnimation,
  type Interp,
  type TimelineContext,
} from './timeline.js';
import { IDENTITY_COMPONENTS, opsSignature, opsToMatrix, parseTransformList, toComponents, type TransformOp } from './transform.js';
import type {
  Animatable,
  ConversionResult,
  ConvertOptions,
  LottieAnimation,
  PathData,
  TransformComponents,
  Value,
} from './types.js';
import { WarningCollector } from './warnings.js';

const NON_RENDERED = new Set([
  'defs', 'style', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'filter', 'title', 'desc', 'metadata',
  'symbol', 'marker', 'pattern', 'animate', 'animateTransform', 'animateColor', 'animateMotion', 'set', 'script',
  'stop', 'font', 'font-face', 'cursor', 'view',
]);
const CONTAINERS = new Set(['g', 'svg', 'a', 'switch']);
const SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path']);

interface Ctx extends TimelineContext, EmitContext {
  doc: SvgDocument;
  viewport: { width: number; height: number };
  assets: Record<string, unknown>[];
  blur: boolean;
  precompCount: number;
}

const interpTransform: Interp<TransformComponents> = (a, b, t) => ({
  anchor: [lerpNumber(a.anchor[0], b.anchor[0], t), lerpNumber(a.anchor[1], b.anchor[1], t)],
  position: [lerpNumber(a.position[0], b.position[0], t), lerpNumber(a.position[1], b.position[1], t)],
  rotation: lerpNumber(a.rotation, b.rotation, t),
  scale: [lerpNumber(a.scale[0], b.scale[0], t), lerpNumber(a.scale[1], b.scale[1], t)],
  skew: lerpNumber(a.skew, b.skew, t),
  skewAxis: lerpNumber(a.skewAxis, b.skewAxis, t),
});

const interpPath: Interp<PathData> = (a, b, t) => {
  if (!sameTopology(a, b)) return t < 1 ? a : b;
  return a.map((p, k) => {
    const q = b[k];
    const l = (x: [number, number][], y: [number, number][]) => x.map((v, i) => [lerpNumber(v[0], y[i][0], t), lerpNumber(v[1], y[i][1], t)] as [number, number]);
    return { v: l(p.v, q.v), i: l(p.i, q.i), o: l(p.o, q.o), c: p.c };
  });
};

// ---------------------------------------------------------------------------------------------
// Value parsing

function parseLength(s: string | undefined, axis: 'x' | 'y' | 'xy', ctx: Ctx): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === '' || t === 'auto') return null;
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  if (t.endsWith('%')) {
    const { width, height } = ctx.viewport;
    const ref = axis === 'x' ? width : axis === 'y' ? height : Math.hypot(width, height) / Math.SQRT2;
    return (n / 100) * ref;
  }
  if (/(em|rem|ex|ch|vw|vh|cm|mm|in|pt|pc)$/.test(t)) {
    const factors: Record<string, number> = { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 4 / 3, pc: 16, em: 16, rem: 16, ex: 8, ch: 8 };
    const unit = /[a-z]+$/.exec(t)![0];
    if (factors[unit]) return n * factors[unit];
    ctx.warnings.add('unit', `Unit "${unit}" treated as px`);
  }
  return n;
}

function parseOpacity(s: string): number | null {
  const t = s.trim();
  const n = parseFloat(t);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, t.endsWith('%') ? n / 100 : n));
}

function state(node: SvgNode, name: string): PropState | undefined {
  return node.props.get(name);
}

function staticValue(node: SvgNode, name: string): string | undefined {
  return node.props.get(name)?.value;
}

function numberAnim(node: SvgNode, name: string, axis: 'x' | 'y' | 'xy', def: number, ctx: Ctx, base?: number): Animatable<number> {
  const st = state(node, name);
  const b = base ?? parseLength(st?.value, axis, ctx) ?? def;
  return buildAnimatable<number>(st, { parse: (s) => parseLength(s, axis, ctx), base: b, interp: lerpNumber, label: node.label, property: name }, ctx);
}

function opacityAnim(node: SvgNode, name: string, ctx: Ctx): Animatable<number> {
  const st = state(node, name);
  const base = st?.value !== undefined ? parseOpacity(st.value) ?? 1 : 1;
  return buildAnimatable<number>(st, { parse: parseOpacity, base, interp: lerpNumber, label: node.label, property: name }, ctx);
}

function hasAnims(node: SvgNode, name: string): boolean {
  return (node.props.get(name)?.anims.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------
// Transforms

interface TransformLevel {
  value: Animatable<TransformComponents>;
}

function originOps(node: SvgNode, ctx: Ctx): [TransformOp[], TransformOp[]] {
  const origin = staticValue(node, 'transform-origin');
  if (!origin) return [[], []];
  const parts = origin.trim().split(/\s+/);
  const kw: Record<string, string> = { left: '0', top: '0', center: '50%', right: '100%', bottom: '100%' };
  const vals = parts.map((p) => kw[p] ?? p);
  const x = vals[0] ?? '0';
  const y = vals[1] ?? (parts[0] === 'top' || parts[0] === 'bottom' ? vals[0] : '50%');
  if (x.endsWith('%') || y.endsWith('%')) {
    const box = staticValue(node, 'transform-box');
    if ((x !== '0%' || y !== '0%') && box && box !== 'view-box') {
      ctx.warnings.add('transform-origin', `transform-origin "${origin}" with transform-box ${box} is resolved against the viewport`, node.label);
    }
  }
  const ox = parseLength(x, 'x', ctx) ?? 0;
  const oy = parseLength(y, 'y', ctx) ?? 0;
  if (ox === 0 && oy === 0) return [[], []];
  return [[{ type: 'translate', x: ox, y: oy }], [{ type: 'translate', x: -ox, y: -oy }]];
}

function componentsFromString(s: string, node: SvgNode, ctx: Ctx, pre: TransformOp[], post: TransformOp[], prev?: TransformComponents) {
  const parsed = parseTransformList(s);
  for (const issue of parsed.issues) ctx.warnings.add('transform', `Transform: ${issue}`, node.label);
  const ops = [...pre, ...parsed.ops, ...post];
  return { ...toComponents(ops, prev?.rotation), ops };
}

function transformChain(node: SvgNode, ctx: Ctx): TransformLevel[] {
  const tState = state(node, 'transform');
  const smil = state(node, 'smil-transform')?.anims ?? [];
  const [pre, post] = originOps(node, ctx);
  const cssDriven = tState && (tState.origin === 'css' || tState.anims.some((a) => a.source === 'css'));
  if (cssDriven || (tState?.anims.length ?? 0) > 0) {
    if (smil.length) ctx.warnings.add('transform-conflict', 'CSS transform overrides <animateTransform>; SMIL transform ignored', node.label);
    const base = componentsFromString(tState!.value ?? '', node, ctx, pre, post).components;
    const signatures = new Set<string>();
    let allExact = true;
    const value = buildAnimatable<TransformComponents>(
      tState,
      {
        parse: (s, prev) => {
          const r = componentsFromString(s, node, ctx, pre, post, prev);
          signatures.add(opsSignature(r.ops));
          allExact &&= r.exact;
          return r.components;
        },
        base,
        interp: interpTransform,
        label: node.label,
        property: 'transform',
      },
      ctx,
    );
    if (signatures.size > 1) {
      ctx.warnings.add('transform-interp', 'Transform keyframes use different function lists; interpolated per component (browser uses matrix interpolation)', node.label);
    } else if (!allExact && isAnimated(value)) {
      ctx.warnings.info('transform-decomposed', 'Animated transform decomposed from matrices; intermediate frames may differ slightly', node.label);
    }
    return [{ value }];
  }
  const attr = node.attrs.get('transform');
  const baseLevel: TransformLevel | null = attr || pre.length ? { value: { static: componentsFromString(attr ?? '', node, ctx, pre, post).components } } : null;
  if (!smil.length) return baseLevel ? [baseLevel] : [];
  let lastReplace = -1;
  smil.forEach((a, k) => {
    if (!a.additive) lastReplace = k;
  });
  const levels: TransformLevel[] = [];
  if (lastReplace < 0 && baseLevel) levels.push(baseLevel);
  for (const anim of smil.slice(Math.max(0, lastReplace))) levels.push({ value: smilTransformLevel(anim, node, ctx, lastReplace >= 0 && !anim.additive ? baseLevel : null) });
  return levels;
}

function smilTransformLevel(anim: PropAnimation, node: SvgNode, ctx: Ctx, replaceBase: TransformLevel | null): Animatable<TransformComponents> {
  const type = anim.transformType ?? 'translate';
  const parse = (s: string): TransformComponents | null => {
    const n = s.split(/[\s,]+/).filter(Boolean).map(Number);
    if (!n.length || n.some((x) => !Number.isFinite(x))) return null;
    switch (type) {
      case 'translate':
        return { ...IDENTITY_COMPONENTS, position: [n[0], n[1] ?? 0] };
      case 'scale':
        return { ...IDENTITY_COMPONENTS, scale: [n[0] * 100, (n[1] ?? n[0]) * 100] };
      case 'rotate':
        return { ...IDENTITY_COMPONENTS, rotation: n[0], anchor: [n[1] ?? 0, n[2] ?? 0], position: [n[1] ?? 0, n[2] ?? 0] };
      case 'skewX':
        return { ...IDENTITY_COMPONENTS, skew: -n[0] };
      case 'skewY':
        ctx.warnings.add('skewY', 'animateTransform type="skewY" approximated via skew axis 90°', node.label);
        return { ...IDENTITY_COMPONENTS, skew: n[0], skewAxis: 90 };
      default:
        return null;
    }
  };
  const base = replaceBase && !isAnimated(replaceBase.value) ? replaceBase.value.static : IDENTITY_COMPONENTS;
  const frames = unrollAnimation(anim, { parse, base, interp: interpTransform, label: node.label, property: `animateTransform ${type}` }, ctx);
  return fromKeyframes(frames, { base });
}

function wrapWithTransforms(name: string, content: unknown[], levels: TransformLevel[], opacity: Animatable<number>, ctx: Ctx): Record<string, unknown> {
  const full: Animatable<number> = { static: 1 };
  if (!levels.length) return group(name, content, shapeTransform({ static: IDENTITY_COMPONENTS }, opacity, ctx));
  let inner: unknown[] = content;
  for (let k = levels.length - 1; k >= 1; k--) inner = [group(`${name} transform ${k}`, inner, shapeTransform(levels[k].value, full, ctx))];
  return group(name, inner, shapeTransform(levels[0].value, opacity, ctx));
}

function staticMatrixOf(levels: TransformLevel[]): Matrix | null {
  let m: Matrix = IDENTITY;
  for (const l of levels) {
    if (isAnimated(l.value)) return null;
    const tc = l.value.static;
    const ops: TransformOp[] = [
      { type: 'translate', x: tc.position[0], y: tc.position[1] },
      { type: 'rotate', deg: tc.rotation },
      { type: 'skewX', deg: -tc.skew },
      { type: 'scale', x: tc.scale[0] / 100, y: tc.scale[1] / 100 },
      { type: 'translate', x: -tc.anchor[0], y: -tc.anchor[1] },
    ];
    m = multiply(m, opsToMatrix(ops));
  }
  return m;
}

// ---------------------------------------------------------------------------------------------
// Geometry

interface Geometry {
  items: Record<string, unknown>[];
  /** [x, y, width, height], for objectBoundingBox gradients */
  bbox: Animatable<number[]>;
}

function pathItems(paths: Animatable<PathData>, name: string, ctx: Ctx): Record<string, unknown>[] {
  const count = isAnimated(paths) ? paths.track.keyframes[0].v.length : paths.static.length;
  const items: Record<string, unknown>[] = [];
  for (let k = 0; k < count; k++) {
    const sub = mapAnimatable(paths, (p) => (p[k] ? [p[k]] : [{ v: [], i: [], o: [], c: false }]) as PathData);
    items.push({ ty: 'sh', nm: count > 1 ? `${name} ${k + 1}` : name, ind: k, d: 1, ks: prop(sub, (p) => shapeValue(p[0]), ctx) });
  }
  return items;
}

function firstValue<T extends Value>(a: Animatable<T>): T {
  return isAnimated(a) ? a.track.keyframes[0].v : a.static;
}

function pathAnim(node: SvgNode, name: string, base: PathData, parse: (s: string) => PathData | null, ctx: Ctx): Animatable<PathData> {
  let incompatible = false;
  const result = buildAnimatable<PathData>(
    state(node, name),
    {
      parse,
      base,
      interp: interpPath,
      compatible: (a, b) => {
        const ok = sameTopology(a, b);
        if (!ok) incompatible = true;
        return ok;
      },
      label: node.label,
      property: name,
    },
    ctx,
  );
  if (incompatible) {
    ctx.warnings.add('path-morph', 'Path morph between shapes with different structure; converted as a discrete switch (as browsers do)', node.label);
  }
  return result;
}

function safeParsePath(s: string, node: SvgNode, ctx: Ctx): PathData | null {
  const m = /^path\(\s*["'](.*)["']\s*\)$/s.exec(s.trim());
  try {
    return parsePathData(m ? m[1] : s);
  } catch (e) {
    ctx.warnings.add('path-parse', `Invalid path data: ${(e as Error).message}`, node.label);
    return null;
  }
}

function bboxOf(paths: Animatable<PathData>): Animatable<number[]> {
  return mapAnimatable(paths, (p) => {
    const b = pathBBox(p);
    return [b.x, b.y, b.width, b.height];
  });
}

function geometry(node: SvgNode, ctx: Ctx): Geometry | null {
  const n = (name: string, axis: 'x' | 'y' | 'xy', def = 0) => numberAnim(node, name, axis, def, ctx);
  const I = lerpNumber as Interp<Value>;
  switch (node.tagName) {
    case 'rect': {
      const x = n('x', 'x');
      const y = n('y', 'y');
      const w = n('width', 'x');
      const h = n('height', 'y');
      const rxSet = staticValue(node, 'rx') !== undefined || hasAnims(node, 'rx');
      const rySet = staticValue(node, 'ry') !== undefined || hasAnims(node, 'ry');
      let rx = n('rx', 'x');
      let ry = n('ry', 'y');
      if (rxSet && !rySet) ry = rx;
      if (rySet && !rxSet) rx = ry;
      const W = firstValue(w);
      const H = firstValue(h);
      if (W <= 0 || H <= 0) return null;
      const bbox = combine([{ value: x, interp: I }, { value: y, interp: I }, { value: w, interp: I }, { value: h, interp: I }], (v) => v as number[], ctx, node.label);
      const rxv = firstValue(rx);
      const ryv = firstValue(ry);
      const clampedDiffer = Math.abs(Math.min(rxv, W / 2) - Math.min(ryv, H / 2)) > 1e-6;
      if (clampedDiffer && !isAnimated(rx) && !isAnimated(ry) && !isAnimated(w) && !isAnimated(h) && !isAnimated(x) && !isAnimated(y)) {
        return { items: pathItems({ static: [rectPath(firstValue(x), firstValue(y), W, H, rxv, ryv)] }, 'Rect', ctx), bbox };
      }
      if (clampedDiffer) ctx.warnings.add('rect-radius', 'Animated rect with different rx/ry uses rx for both corners', node.label);
      const p = combine([{ value: x, interp: I }, { value: y, interp: I }, { value: w, interp: I }, { value: h, interp: I }], (v) => [(v[0] as number) + (v[2] as number) / 2, (v[1] as number) + (v[3] as number) / 2], ctx, node.label);
      const s = combine([{ value: w, interp: I }, { value: h, interp: I }], (v) => [v[0] as number, v[1] as number], ctx, node.label);
      return {
        items: [{ ty: 'rc', nm: 'Rect', d: 1, p: prop(p, (v) => v as number[], ctx), s: prop(s, (v) => v as number[], ctx), r: prop(rx, (v) => Math.max(0, v), ctx) }],
        bbox,
      };
    }
    case 'circle':
    case 'ellipse': {
      const cx = n('cx', 'x');
      const cy = n('cy', 'y');
      let rx: Animatable<number>;
      let ry: Animatable<number>;
      if (node.tagName === 'circle') rx = ry = n('r', 'xy');
      else {
        rx = n('rx', 'x');
        ry = n('ry', 'y');
        if (staticValue(node, 'ry') === undefined && !hasAnims(node, 'ry')) ry = rx;
        if (staticValue(node, 'rx') === undefined && !hasAnims(node, 'rx')) rx = ry;
      }
      if (firstValue(rx) <= 0 && !isAnimated(rx)) return null;
      const p = combine([{ value: cx, interp: I }, { value: cy, interp: I }], (v) => [v[0] as number, v[1] as number], ctx, node.label);
      const s = combine([{ value: rx, interp: I }, { value: ry, interp: I }], (v) => [(v[0] as number) * 2, (v[1] as number) * 2], ctx, node.label);
      const bbox = combine(
        [{ value: cx, interp: I }, { value: cy, interp: I }, { value: rx, interp: I }, { value: ry, interp: I }],
        (v) => {
          const [a, b, c, d] = v as number[];
          return [a - c, b - d, 2 * c, 2 * d];
        },
        ctx,
        node.label,
      );
      return { items: [{ ty: 'el', nm: 'Ellipse', d: 1, p: prop(p, (v) => v as number[], ctx), s: prop(s, (v) => v as number[], ctx) }], bbox };
    }
    case 'line': {
      const vals = ['x1', 'y1', 'x2', 'y2'].map((a, k) => ({ value: n(a, k % 2 ? 'y' : 'x'), interp: I }));
      const paths = combine(vals, (v) => [polyPath(v as number[], false)] as PathData, ctx, node.label);
      return { items: pathItems(paths, 'Line', ctx), bbox: bboxOf(paths) };
    }
    case 'polyline':
    case 'polygon': {
      const closed = node.tagName === 'polygon';
      const parse = (s: string) => [polyPath(parsePoints(s), closed)] as PathData;
      const base = parse(staticValue(node, 'points') ?? '');
      if (base[0].v.length < 2 && !hasAnims(node, 'points')) return null;
      const paths = pathAnim(node, 'points', base, parse, ctx);
      return { items: pathItems(paths, closed ? 'Polygon' : 'Polyline', ctx), bbox: bboxOf(paths) };
    }
    case 'path': {
      const base = safeParsePath(staticValue(node, 'd') ?? '', node, ctx) ?? [];
      if (!base.length && !hasAnims(node, 'd')) return null;
      const paths = pathAnim(node, 'd', base, (s) => safeParsePath(s, node, ctx), ctx);
      return { items: pathItems(paths, 'Path', ctx), bbox: bboxOf(paths) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Paint

function resolveHref(node: SvgNode, ctx: Ctx): SvgNode | undefined {
  const href = node.attrs.get('href') ?? node.attrs.get('xlink:href');
  return href?.startsWith('#') ? ctx.doc.byId.get(href.slice(1)) : undefined;
}

function urlRef(value: string | undefined): string | null {
  const m = value ? /url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(value) : null;
  return m ? m[1] : null;
}

function gradientAttr(g: SvgNode, name: string, ctx: Ctx, seen = new Set<SvgNode>()): string | undefined {
  if (g.attrs.has(name)) return g.attrs.get(name);
  seen.add(g);
  const ref = resolveHref(g, ctx);
  return ref && !seen.has(ref) ? gradientAttr(ref, name, ctx, seen) : undefined;
}

function gradientStops(g: SvgNode, ctx: Ctx, seen = new Set<SvgNode>()): SvgNode[] {
  const stops = g.children.filter((c) => c.tagName === 'stop');
  if (stops.length) return stops;
  seen.add(g);
  const ref = resolveHref(g, ctx);
  return ref && !seen.has(ref) ? gradientStops(ref, ctx, seen) : [];
}

function gradientItem(kind: 'fill' | 'stroke', g: SvgNode, geo: Geometry, opacity: Animatable<number>, node: SvgNode, ctx: Ctx): Record<string, unknown> | null {
  const stops = gradientStops(g, ctx);
  if (!stops.length) return null;
  if (stops.some((s) => s.props.get('stop-color')?.anims.length || s.props.get('stop-opacity')?.anims.length)) {
    ctx.warnings.add('gradient-animation', 'Animated gradient stops are not supported; first frame used', node.label);
  }
  let lastOffset = 0;
  const parsedStops = stops.map((s) => {
    const off = s.props.get('offset')?.value ?? '0';
    let o = parseFloat(off);
    if (off.trim().endsWith('%')) o /= 100;
    o = Math.min(1, Math.max(lastOffset, Number.isFinite(o) ? o : 0));
    lastOffset = o;
    const c = parseColor(s.props.get('stop-color')?.value ?? 'black') ?? [0, 0, 0, 1];
    const so = parseOpacity(s.props.get('stop-opacity')?.value ?? '1') ?? 1;
    return { o, c, a: c[3] * so };
  });
  const colors = parsedStops.flatMap((s) => [s.o, s.c[0], s.c[1], s.c[2]]);
  const hasAlpha = parsedStops.some((s) => s.a < 1);
  const k = hasAlpha ? [...colors, ...parsedStops.flatMap((s) => [s.o, s.a])] : colors;

  const units = gradientAttr(g, 'gradientUnits', ctx) ?? 'objectBoundingBox';
  const bboxUnits = units !== 'userSpaceOnUse';
  const gm: Matrix = opsToMatrix(parseTransformList(gradientAttr(g, 'gradientTransform', ctx)).ops);
  const matrixFor = (b: number[]): Matrix => (bboxUnits ? multiply(multiply(translateM(b[0], b[1]), scaleM(b[2], b[3])), gm) : gm);
  const len = (name: string, def: string, axis: 'x' | 'y' | 'xy') => {
    const v = gradientAttr(g, name, ctx) ?? def;
    if (bboxUnits) return v.trim().endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
    return parseLength(v, axis, ctx) ?? 0;
  };
  const bbox: Animatable<number[]> = bboxUnits ? geo.bbox : { static: [0, 0, 1, 1] };
  const m0 = matrixFor(firstValue(bbox));
  const nonUniform = Math.abs(Math.hypot(m0[0], m0[1]) - Math.hypot(m0[2], m0[3])) > 1e-6 || Math.abs(m0[0] * m0[2] + m0[1] * m0[3]) > 1e-6;
  let item: Record<string, unknown>;
  if (g.tagName === 'linearGradient') {
    const p1: [number, number] = [len('x1', '0%', 'x'), len('y1', '0%', 'y')];
    const p2: [number, number] = [len('x2', '100%', 'x'), len('y2', '0%', 'y')];
    // Under an affine map, isolines stay parallel but may no longer be perpendicular to the mapped
    // gradient vector; project the mapped end point onto the normal of the mapped isolines instead.
    const ends = mapAnimatable(bbox, (b) => {
      const m = matrixFor(b);
      const s0 = apply(m, p1);
      const e0 = apply(m, p2);
      const iso = applyVector(m, [-(p2[1] - p1[1]), p2[0] - p1[0]]);
      const n: [number, number] = [iso[1], -iso[0]];
      const nn = n[0] * n[0] + n[1] * n[1];
      if (nn < 1e-12) return [s0[0], s0[1], e0[0], e0[1]];
      const k = ((e0[0] - s0[0]) * n[0] + (e0[1] - s0[1]) * n[1]) / nn;
      return [s0[0], s0[1], s0[0] + k * n[0], s0[1] + k * n[1]];
    });
    item = { t: 1, s: prop(ends, (v) => [v[0], v[1]], ctx), e: prop(ends, (v) => [v[2], v[3]], ctx) };
  } else {
    const cx = len('cx', '50%', 'x');
    const cy = len('cy', '50%', 'y');
    const r = len('r', '50%', 'xy');
    const ends = mapAnimatable(bbox, (b) => {
      const m = matrixFor(b);
      const c = apply(m, [cx, cy]);
      const e = apply(m, [cx + r, cy]);
      return [c[0], c[1], e[0], e[1]];
    });
    if (nonUniform) ctx.warnings.add('gradient-transform', 'Elliptical radial gradient approximated as circular (Lottie radial gradients are circular)', node.label);
    const fx = gradientAttr(g, 'fx', ctx);
    const fy = gradientAttr(g, 'fy', ctx);
    item = { t: 2, s: prop(ends, (v) => [v[0], v[1]], ctx), e: prop(ends, (v) => [v[2], v[3]], ctx), h: staticProp(0), a: staticProp(0) };
    if ((fx !== undefined && len('fx', '50%', 'x') !== cx) || (fy !== undefined && len('fy', '50%', 'y') !== cy)) {
      ctx.warnings.add('gradient-focal', 'Radial gradient focal point (fx/fy) ignored', node.label);
    }
  }
  const spread = gradientAttr(g, 'spreadMethod', ctx);
  if (spread && spread !== 'pad') ctx.warnings.add('gradient-spread', `spreadMethod="${spread}" not supported; using pad`, node.label);
  return {
    ty: kind === 'fill' ? 'gf' : 'gs',
    nm: kind === 'fill' ? 'Gradient Fill' : 'Gradient Stroke',
    o: prop(opacity, (v) => v * 100, ctx),
    g: { p: parsedStops.length, k: staticProp(k) },
    ...item,
  };
}

function colorAnim(node: SvgNode, name: string, ctx: Ctx, fallback: RGBA): Animatable<number[]> {
  const st = state(node, name);
  const base = (st?.value && resolveColor(st.value, node)) || fallback;
  return buildAnimatable<number[]>(st, { parse: (s) => resolveColor(s, node), base, interp: lerpArray, label: node.label, property: name }, ctx);
}

function resolveColor(s: string, node: SvgNode): RGBA | null {
  if (s.trim() === 'currentColor') return parseColor(node.props.get('color')?.value ?? 'black');
  return parseColor(s);
}

function paintItems(node: SvgNode, geo: Geometry, ctx: Ctx): Record<string, unknown>[] {
  const out: { kind: 'fill' | 'stroke'; item: Record<string, unknown> }[] = [];
  for (const kind of ['fill', 'stroke'] as const) {
    const st = state(node, kind);
    const raw = st?.value ?? (kind === 'fill' ? 'black' : 'none');
    const animated = (st?.anims.length ?? 0) > 0;
    if (raw.trim() === 'none' && !animated) continue;
    if (raw.trim() === 'none' && animated) ctx.warnings.add('paint-none', `Animated ${kind} starting from "none" is converted from its first keyframe`, node.label);
    const opacity = opacityAnim(node, `${kind}-opacity`, ctx);
    const ref = urlRef(raw);
    if (ref) {
      const target = ctx.doc.byId.get(ref);
      if (!target || (target.tagName !== 'linearGradient' && target.tagName !== 'radialGradient')) {
        ctx.warnings.add('paint-server', `${kind}="${raw}" references ${target ? `<${target.tagName}>` : 'a missing element'}, which is not supported`, node.label);
        const fb = /url\([^)]*\)\s*(.+)$/.exec(raw)?.[1];
        if (!fb || !parseColor(fb)) continue;
      } else {
        const item = gradientItem(kind, target, geo, opacity, node, ctx);
        if (item) {
          if (kind === 'stroke') Object.assign(item, strokeProps(node, ctx));
          out.push({ kind, item });
        }
        continue;
      }
    }
    const color = colorAnim(node, kind, ctx, [0, 0, 0, 1]);
    const alpha = mapAnimatable(color, (c) => c[3] ?? 1);
    const I = lerpNumber as Interp<Value>;
    const o = combine([{ value: opacity, interp: I }, { value: alpha, interp: I }], (v) => (v[0] as number) * (v[1] as number), ctx, node.label);
    const c = prop(color, (v) => [v[0], v[1], v[2], 1], ctx);
    if (kind === 'fill') {
      out.push({ kind, item: { ty: 'fl', nm: 'Fill', c, o: prop(o, (v) => v * 100, ctx), r: staticValue(node, 'fill-rule') === 'evenodd' ? 2 : 1, bm: 0 } });
    } else {
      out.push({ kind, item: { ty: 'st', nm: 'Stroke', c, o: prop(o, (v) => v * 100, ctx), ...strokeProps(node, ctx), bm: 0 } });
    }
  }
  // Items listed first render on top: SVG paints fill, then stroke (unless paint-order says otherwise).
  const order = staticValue(node, 'paint-order') ?? 'normal';
  const strokeFirst = /^\s*stroke/.test(order) || /^\s*markers\s+stroke/.test(order);
  out.sort((a, b) => (a.kind === b.kind ? 0 : strokeFirst ? (a.kind === 'fill' ? -1 : 1) : a.kind === 'stroke' ? -1 : 1));
  if (staticValue(node, 'vector-effect') === 'non-scaling-stroke') ctx.warnings.add('non-scaling-stroke', 'vector-effect="non-scaling-stroke" not supported; stroke scales with transforms', node.label);
  return out.map((o) => o.item);
}

function strokeProps(node: SvgNode, ctx: Ctx): Record<string, unknown> {
  const w = numberAnim(node, 'stroke-width', 'xy', 1, ctx);
  const caps: Record<string, number> = { butt: 1, round: 2, square: 3 };
  const joins: Record<string, number> = { miter: 1, round: 2, bevel: 3, 'miter-clip': 1, arcs: 1 };
  const res: Record<string, unknown> = {
    w: prop(w, (v) => v, ctx),
    lc: caps[staticValue(node, 'stroke-linecap') ?? 'butt'] ?? 1,
    lj: joins[staticValue(node, 'stroke-linejoin') ?? 'miter'] ?? 1,
    ml: parseFloat(staticValue(node, 'stroke-miterlimit') ?? '4') || 4,
  };
  const dashRaw = staticValue(node, 'stroke-dasharray');
  if (hasAnims(node, 'stroke-dasharray')) ctx.warnings.add('dasharray-animation', 'Animated stroke-dasharray is not supported; static value used', node.label);
  if (dashRaw && dashRaw !== 'none') {
    let dashes = dashRaw.split(/[\s,]+/).filter(Boolean).map((d) => parseLength(d, 'xy', ctx) ?? 0);
    if (dashes.length % 2) dashes = [...dashes, ...dashes];
    if (dashes.some((d) => d > 0)) {
      const offset = numberAnim(node, 'stroke-dashoffset', 'xy', 0, ctx);
      res.d = [
        ...dashes.map((d, k) => ({ n: k % 2 ? 'g' : 'd', nm: k % 2 ? 'gap' : 'dash', v: staticProp(d) })),
        { n: 'o', nm: 'offset', v: prop(offset, (v) => v, ctx) },
      ];
    }
  } else if (hasAnims(node, 'stroke-dashoffset')) {
    ctx.warnings.add('dashoffset', 'stroke-dashoffset animated without stroke-dasharray has no effect', node.label);
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Layer features: filters and clip paths

interface LayerFeatures {
  effects: Record<string, unknown>[];
  masks: Record<string, unknown>[];
  /** whether the mask geometry is expressed in the node's own (post-transform) space */
  masksInLocalSpace: boolean;
}

function isHidden(node: SvgNode): boolean {
  return staticValue(node, 'display') === 'none' || (staticValue(node, 'visibility') === 'hidden' && !node.children.length);
}

function blurFilter(node: SvgNode, ctx: Ctx): { sigma: number } | 'none' | 'unsupported' {
  const ref = urlRef(staticValue(node, 'filter'));
  if (!ref) {
    const f = staticValue(node, 'filter');
    if (f && f !== 'none') {
      const m = /^blur\(\s*([\d.]+)(px)?\s*\)$/.exec(f.trim());
      if (m) return { sigma: parseFloat(m[1]) };
      ctx.warnings.add('filter', `CSS filter "${f}" is not supported`, node.label);
      return 'unsupported';
    }
    return 'none';
  }
  const filter = ctx.doc.byId.get(ref);
  if (!filter) return 'none';
  const prims = filter.children.filter((c) => c.tagName.startsWith('fe'));
  const blur = prims.find((p) => p.tagName === 'feGaussianBlur');
  const others = prims.filter((p) => {
    if (p === blur) return false;
    if (p.tagName === 'feFlood' && parseFloat(p.attrs.get('flood-opacity') ?? '1') === 0) return false;
    if (p.tagName === 'feBlend' && (p.attrs.get('in') ?? 'SourceGraphic') === 'SourceGraphic' && (p.attrs.get('mode') ?? 'normal') === 'normal') return false;
    return true;
  });
  if (!blur || others.length) {
    const names = [...new Set(prims.map((p) => p.tagName))].join(', ');
    const shadow = prims.some((p) => p.tagName === 'feOffset');
    ctx.warnings.add('filter', `${shadow ? 'Drop/inner shadow' : 'Filter'} (${names}) is not supported and was ignored`, node.label);
    return 'unsupported';
  }
  const sd = (blur.attrs.get('stdDeviation') ?? '0').split(/[\s,]+/).map(Number);
  if (sd.length > 1 && sd[0] !== sd[1]) ctx.warnings.add('filter', 'Directional blur approximated with the average stdDeviation', node.label);
  return { sigma: sd.length > 1 ? (sd[0] + sd[1]) / 2 : sd[0] };
}

function clipPathTarget(node: SvgNode, ctx: Ctx): SvgNode | null {
  const ref = urlRef(staticValue(node, 'clip-path'));
  if (!ref) return null;
  const cp = ctx.doc.byId.get(ref);
  return cp && cp.tagName === 'clipPath' ? cp : null;
}

/** Figma wraps every frame in a clip-path equal to the canvas; it is a no-op and can be dropped. */
function isTrivialClip(node: SvgNode, cp: SvgNode, ctx: Ctx): boolean {
  const shapes = cp.children.filter((c) => SHAPES.has(c.tagName));
  if (shapes.length !== 1 || shapes[0].tagName !== 'rect' || shapes[0].attrs.has('transform')) return false;
  if ((cp.attrs.get('clipPathUnits') ?? 'userSpaceOnUse') !== 'userSpaceOnUse') return false;
  if (node.parent !== ctx.doc.root || transformChain(node, ctx).length) return false;
  const r = shapes[0];
  const x = parseFloat(r.attrs.get('x') ?? '0');
  const y = parseFloat(r.attrs.get('y') ?? '0');
  const w = parseLength(r.attrs.get('width'), 'x', ctx) ?? 0;
  const h = parseLength(r.attrs.get('height'), 'y', ctx) ?? 0;
  const vb = viewBox(ctx.doc.root, ctx);
  return x <= vb[0] && y <= vb[1] && x + w >= vb[0] + vb[2] && y + h >= vb[1] + vb[3];
}

function needsLayer(node: SvgNode, ctx: Ctx): boolean {
  const cp = clipPathTarget(node, ctx);
  if (cp && !isTrivialClip(node, cp, ctx)) return true;
  if (staticValue(node, 'mask')?.startsWith('url(')) return false;
  const f = staticValue(node, 'filter');
  if (!ctx.blur || !f || f === 'none') return false;
  // Probe with a throwaway collector; the real warnings are emitted when the layer is built.
  return typeof blurFilter(node, { ...ctx, warnings: new WarningCollector() }) === 'object';
}

function subtreeNeedsLayer(node: SvgNode, ctx: Ctx): boolean {
  if (isHidden(node)) return false;
  if (needsLayer(node, ctx)) return true;
  if (node.tagName === 'use') {
    const ref = resolveHref(node, ctx);
    return ref ? subtreeNeedsLayer(ref, ctx) : false;
  }
  return CONTAINERS.has(node.tagName) && node.children.some((c) => subtreeNeedsLayer(c, ctx));
}

function layerFeatures(node: SvgNode, levels: TransformLevel[], ctx: Ctx): LayerFeatures {
  const features: LayerFeatures = { effects: [], masks: [], masksInLocalSpace: true };
  const f = blurFilter(node, ctx);
  if (typeof f === 'object') {
    if (!ctx.blur) ctx.warnings.add('filter', 'Blur filter dropped (blur output disabled)', node.label);
    else if (f.sigma > 0) {
      if (hasAnims(node, 'filter')) ctx.warnings.add('filter-animation', 'Animated filter is not supported; static blur used', node.label);
      ctx.warnings.info('blur-effect', 'Blur filter converted to a Lottie Gaussian Blur effect; supported by lottie-web (SVG/canvas) and ThorVG-based dotLottie players, not by all renderers', node.label);
      features.effects.push(blurEffect(f.sigma));
    }
  }
  const cp = clipPathTarget(node, ctx);
  if (cp && !isTrivialClip(node, cp, ctx)) {
    if ((cp.attrs.get('clipPathUnits') ?? 'userSpaceOnUse') !== 'userSpaceOnUse') {
      ctx.warnings.add('clip-units', 'clipPathUnits="objectBoundingBox" not supported; clip ignored', node.label);
    } else {
      const cpMatrix = opsToMatrix(parseTransformList(cp.attrs.get('transform')).ops);
      let pre: Matrix = cpMatrix;
      if (levels.length > 1) {
        const sm = staticMatrixOf(levels);
        if (sm) {
          pre = multiply(sm, cpMatrix);
          features.masksInLocalSpace = false;
        } else ctx.warnings.add('clip-transform', 'Clip path on an element with stacked animated transforms may be misplaced', node.label);
      }
      for (const shape of cp.children) {
        if (!SHAPES.has(shape.tagName) && shape.tagName !== 'use') continue;
        const target = shape.tagName === 'use' ? resolveHref(shape, ctx) : shape;
        if (!target) continue;
        const staticPath = staticGeometryPath(target, ctx);
        if (!staticPath) continue;
        const shapeM = multiply(pre, opsToMatrix(parseTransformList(target.attrs.get('transform')).ops));
        for (const p of transformPath(staticPath, shapeM)) {
          features.masks.push({ inv: false, mode: 'a', pt: staticProp(shapeValue(p)), o: staticProp(100), x: staticProp(0), nm: `Clip ${cp.attrs.get('id') ?? ''}`.trim() });
        }
        if (target.props.get('d')?.anims.length || ['x', 'y', 'width', 'height', 'r', 'cx', 'cy', 'rx', 'ry'].some((a) => hasAnims(target, a))) {
          ctx.warnings.add('clip-animation', 'Animated clip-path geometry is not supported; first frame used', node.label);
        }
      }
      if (features.masks.length > 1) ctx.warnings.info('clip-union', 'Multi-shape clip path converted to additive masks', node.label);
    }
  }
  return features;
}

function staticGeometryPath(node: SvgNode, ctx: Ctx): PathData | null {
  const g = (name: string, axis: 'x' | 'y' | 'xy', def = 0) => parseLength(staticValue(node, name), axis, ctx) ?? def;
  switch (node.tagName) {
    case 'rect': {
      let rx = parseLength(staticValue(node, 'rx'), 'x', ctx);
      let ry = parseLength(staticValue(node, 'ry'), 'y', ctx);
      if (rx === null) rx = ry ?? 0;
      if (ry === null) ry = rx;
      return [rectPath(g('x', 'x'), g('y', 'y'), g('width', 'x'), g('height', 'y'), rx, ry)];
    }
    case 'circle':
      return [ellipsePath(g('cx', 'x'), g('cy', 'y'), g('r', 'xy'), g('r', 'xy'))];
    case 'ellipse':
      return [ellipsePath(g('cx', 'x'), g('cy', 'y'), g('rx', 'x'), g('ry', 'y'))];
    case 'line':
      return [polyPath([g('x1', 'x'), g('y1', 'y'), g('x2', 'x'), g('y2', 'y')], false)];
    case 'polyline':
    case 'polygon':
      return [polyPath(parsePoints(staticValue(node, 'points') ?? ''), node.tagName === 'polygon')];
    case 'path':
      return safeParsePath(staticValue(node, 'd') ?? '', node, ctx);
  }
  return null;
}

function blurEffect(sigma: number): Record<string, unknown> {
  // Both lottie-web and ThorVG convert blurriness to a Gaussian sigma with a 0.3 factor.
  return {
    ty: 29,
    nm: 'Gaussian Blur',
    np: 5,
    mn: 'ADBE Gaussian Blur 2',
    ix: 1,
    en: 1,
    ef: [
      { ty: 0, nm: 'Blurriness', mn: 'ADBE Gaussian Blur 2-0001', ix: 1, v: staticProp(sigma / 0.3) },
      { ty: 7, nm: 'Blur Dimensions', mn: 'ADBE Gaussian Blur 2-0002', ix: 2, v: staticProp(1) },
      { ty: 7, nm: 'Repeat Edge Pixels', mn: 'ADBE Gaussian Blur 2-0003', ix: 3, v: staticProp(0) },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Tree → shapes / layers

const UNSUPPORTED_ELEMENTS: Record<string, string> = {
  text: 'Text is not supported; convert text to outlines in Figma before exporting',
  image: '<image> is not supported',
  foreignObject: '<foreignObject> is not supported',
};

function emitNode(node: SvgNode, ctx: Ctx, opts: { skipTransform?: boolean; depth?: number } = {}): Record<string, unknown> | null {
  if (isHidden(node) || NON_RENDERED.has(node.tagName)) return null;
  const depth = opts.depth ?? 0;
  if (depth > 64) {
    ctx.warnings.add('depth', 'Maximum nesting depth exceeded (circular <use>?)', node.label);
    return null;
  }
  if (UNSUPPORTED_ELEMENTS[node.tagName]) {
    ctx.warnings.add(`unsupported-${node.tagName}`, UNSUPPORTED_ELEMENTS[node.tagName], node.label);
    return null;
  }
  if (staticValue(node, 'mask')?.startsWith('url(')) ctx.warnings.add('mask', '<mask> is not supported and was ignored (use clip-path for hard-edged clipping)', node.label);
  const handledAsLayer = depth === 0 && needsLayer(node, ctx);
  if (!handledAsLayer) {
    const filter = staticValue(node, 'filter');
    const blur = filter && filter !== 'none' ? blurFilter(node, ctx) : 'none';
    const cp = clipPathTarget(node, ctx);
    if (typeof blur === 'object' && !ctx.blur) ctx.warnings.add('filter', 'Blur filter dropped (blur output disabled)', node.label);
    else if (typeof blur === 'object' || (cp && !isTrivialClip(node, cp, ctx))) {
      ctx.warnings.add('nested-layer-feature', 'Clip/filter on an element nested inside a shape group cannot be represented; ignored', node.label);
    }
  }
  const levels = opts.skipTransform ? [] : transformChain(node, ctx);
  const opacity: Animatable<number> = opts.skipTransform ? { static: 1 } : opacityAnim(node, 'opacity', ctx);
  let content: unknown[] = [];
  if (CONTAINERS.has(node.tagName)) {
    if (node.tagName === 'svg' && node !== ctx.doc.root) {
      const x = parseLength(node.attrs.get('x'), 'x', ctx) ?? 0;
      const y = parseLength(node.attrs.get('y'), 'y', ctx) ?? 0;
      if (node.attrs.has('viewBox')) ctx.warnings.add('nested-svg', 'Nested <svg> viewBox scaling/clipping is ignored', node.label);
      if (x || y) levels.unshift({ value: { static: { ...IDENTITY_COMPONENTS, position: [x, y] } } });
    }
    content = [...node.children].reverse().map((c) => emitNode(c, ctx, { depth: depth + 1 })).filter(Boolean) as unknown[];
    if (!content.length) return null;
  } else if (node.tagName === 'use') {
    const ref = resolveHref(node, ctx);
    if (!ref) {
      ctx.warnings.add('use-missing', '<use> reference not found', node.label);
      return null;
    }
    if (ref.tagName === 'symbol') ctx.warnings.add('use-symbol', '<use> of <symbol> ignores symbol viewBox', node.label);
    const x = parseLength(node.attrs.get('x'), 'x', ctx) ?? 0;
    const y = parseLength(node.attrs.get('y'), 'y', ctx) ?? 0;
    const inner =
      ref.tagName === 'symbol'
        ? [...ref.children].reverse().map((c) => emitNode(c, ctx, { depth: depth + 1 })).filter(Boolean)
        : [emitNode(ref, ctx, { depth: depth + 1 })].filter(Boolean);
    if (!inner.length) return null;
    content = x || y ? [group('use offset', inner, shapeTransform({ static: { ...IDENTITY_COMPONENTS, position: [x, y] } }, { static: 1 }, ctx))] : inner;
  } else if (SHAPES.has(node.tagName)) {
    const geo = geometry(node, ctx);
    if (!geo) return null;
    const paints = paintItems(node, geo, ctx);
    if (!paints.length) return null;
    content = [...geo.items, ...paints];
  } else {
    ctx.warnings.add('unknown-element', `<${node.tagName}> is not supported and was ignored`, node.label);
    return null;
  }
  return wrapWithTransforms(node.attrs.get('id') ?? node.tagName, content, levels, opacity, ctx);
}

function baseLayer(name: string, ctx: Ctx): Record<string, unknown> {
  return {
    ddd: 0,
    nm: name,
    sr: 1,
    ao: 0,
    ip: 0,
    op: Math.round(ctx.duration * ctx.fps),
    st: 0,
    bm: 0,
    ks: layerTransform({ static: IDENTITY_COMPONENTS }, { static: 1 }, ctx),
  };
}

function applyFeatures(layer: Record<string, unknown>, node: SvgNode, levels: TransformLevel[], ctx: Ctx): { consumedTransform: boolean } {
  const features = layerFeatures(node, levels, ctx);
  if (features.effects.length) layer.ef = features.effects;
  if (features.masks.length) {
    layer.hasMask = true;
    layer.masksProperties = features.masks;
  }
  const consume = levels.length === 1 && (features.effects.length > 0 || features.masks.length > 0);
  if (consume) layer.ks = layerTransform(levels[0].value, opacityAnim(node, 'opacity', ctx), ctx);
  return { consumedTransform: consume };
}

function emitLayers(nodes: SvgNode[], ctx: Ctx): Record<string, unknown>[] {
  const layers: Record<string, unknown>[] = [];
  for (const node of [...nodes].reverse()) {
    if (isHidden(node) || NON_RENDERED.has(node.tagName)) continue;
    const name = node.attrs.get('id') ?? node.tagName;
    const isContainer = CONTAINERS.has(node.tagName);
    if (isContainer && node.children.some((c) => subtreeNeedsLayer(c, ctx))) {
      const levels = transformChain(node, ctx);
      const opacity = opacityAnim(node, 'opacity', ctx);
      const plain = !levels.length && !isAnimated(opacity) && opacity.static === 1 && !needsLayer(node, ctx);
      if (plain) {
        const cp = clipPathTarget(node, ctx);
        if (cp && isTrivialClip(node, cp, ctx)) ctx.warnings.info('trivial-clip', 'Canvas-sized clip-path dropped', node.label);
        layers.push(...emitLayers(node.children, ctx));
        continue;
      }
      const id = `comp_${ctx.precompCount++}`;
      ctx.assets.push({ id, nm: name, layers: numberLayers(emitLayers(node.children, ctx)) });
      const layer: Record<string, unknown> = { ...baseLayer(name, ctx), ty: 0, refId: id, w: ctx.viewport.width, h: ctx.viewport.height };
      const { consumedTransform } = applyFeatures(layer, node, levels, ctx);
      if (!consumedTransform) {
        if (levels.length > 1) ctx.warnings.add('precomp-transform', 'Stacked transforms on a group containing filters/clips were reduced to the first', node.label);
        layer.ks = layerTransform(levels[0]?.value ?? { static: IDENTITY_COMPONENTS }, opacity, ctx);
      }
      layers.push(layer);
      continue;
    }
    const layer: Record<string, unknown> = { ...baseLayer(name, ctx), ty: 4 };
    const levels = needsLayer(node, ctx) ? transformChain(node, ctx) : [];
    let consumed = false;
    if (needsLayer(node, ctx)) consumed = applyFeatures(layer, node, levels, ctx).consumedTransform;
    const shape = emitNode(node, ctx, { skipTransform: consumed });
    if (!shape) continue;
    layer.shapes = [shape];
    layers.push(layer);
  }
  return layers;
}

function numberLayers(layers: Record<string, unknown>[], start = 1): Record<string, unknown>[] {
  layers.forEach((l, k) => (l.ind = start + k));
  return layers;
}

// ---------------------------------------------------------------------------------------------
// Viewport

function viewBox(root: SvgNode, ctx: Pick<Ctx, 'warnings'>): [number, number, number, number] {
  const vb = root.attrs.get('viewBox')?.split(/[\s,]+/).map(Number);
  if (vb && vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0) return vb as [number, number, number, number];
  const w = parseFloat(root.attrs.get('width') ?? '');
  const h = parseFloat(root.attrs.get('height') ?? '');
  if (!(w > 0 && h > 0)) ctx.warnings.add('viewport', 'SVG has no viewBox or width/height; assuming 300×150');
  return [0, 0, w > 0 ? w : 300, h > 0 ? h : 150];
}

function viewport(root: SvgNode, warnings: WarningCollector): { width: number; height: number; matrix: Matrix } {
  const vb = viewBox(root, { warnings });
  const wAttr = root.attrs.get('width');
  const hAttr = root.attrs.get('height');
  const px = (s: string | undefined) => (s && !s.trim().endsWith('%') && parseFloat(s) > 0 ? parseFloat(s) : null);
  let width = px(wAttr);
  let height = px(hAttr);
  if (width === null && height === null) {
    width = vb[2];
    height = vb[3];
  } else if (width === null) width = (height! * vb[2]) / vb[3];
  else if (height === null) height = (width * vb[3]) / vb[2];
  const par = (root.attrs.get('preserveAspectRatio') ?? 'xMidYMid meet').trim().split(/\s+/);
  let sx = width! / vb[2];
  let sy = height! / vb[3];
  let tx = 0;
  let ty = 0;
  if (par[0] !== 'none') {
    const s = par[1] === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
    const align = par[0];
    const ax = align.includes('xMin') ? 0 : align.includes('xMax') ? 1 : 0.5;
    const ay = align.includes('YMin') ? 0 : align.includes('YMax') ? 1 : 0.5;
    tx = (width! - vb[2] * s) * ax;
    ty = (height! - vb[3] * s) * ay;
    sx = sy = s;
  }
  const matrix: Matrix = [sx, 0, 0, sy, tx - vb[0] * sx, ty - vb[1] * sy];
  return { width: Math.round(width!), height: Math.round(height!), matrix };
}

// ---------------------------------------------------------------------------------------------

export function convertSvg(svg: string, options: ConvertOptions = {}): ConversionResult {
  const warnings = new WarningCollector();
  const doc = parseSvgDocument(svg, warnings);
  const fps = options.fps ?? 60;
  const maxDuration = options.maxDuration ?? 30;
  const vp = viewport(doc.root, warnings);
  const duration = computeDuration(doc.animations, fps, maxDuration, warnings);
  const ctx: Ctx = {
    doc,
    fps,
    duration,
    warnings,
    viewport: { width: vp.width, height: vp.height },
    assets: [],
    blur: options.blur ?? true,
    precompCount: 0,
    animatedProperties: 0,
    keyframes: 0,
  };
  for (const a of doc.animations) {
    if (Number.isFinite(a.iterations) || a.delay === 0) continue;
    warnings.info('loop-delay', `Looping animation with ${a.delay}s delay converted to its steady-state loop (the first cycle's delay is not reproduced)`, a.label);
  }
  let layers = emitLayers(doc.root.children, ctx);
  if (!isIdentity(vp.matrix)) {
    const nullLayer: Record<string, unknown> = {
      ...baseLayer('viewBox', ctx),
      ty: 3,
      ks: layerTransform(
        { static: { ...IDENTITY_COMPONENTS, position: [vp.matrix[4], vp.matrix[5]], scale: [vp.matrix[0] * 100, vp.matrix[3] * 100] } },
        { static: 1 },
        ctx,
      ),
    };
    numberLayers(layers, 2);
    for (const l of layers) l.parent = 1;
    nullLayer.ind = 1;
    layers = [...layers, nullLayer];
    // Precomp contents live in viewBox space too, so their layer size must follow the viewBox.
    const vb = viewBox(doc.root, { warnings });
    for (const l of layers) if (l.ty === 0) Object.assign(l, { w: vb[2], h: vb[3] });
  } else numberLayers(layers);
  if (!layers.length) warnings.add('empty', 'No renderable content found', undefined, 'error');

  const name = options.name ?? doc.root.children.find((c) => c.tagName === 'title')?.text.trim() ?? doc.root.attrs.get('id') ?? 'svg2lottie';
  const frames = Math.round(duration * fps);
  const animation: LottieAnimation = roundDeep(
    {
      v: '5.7.4',
      meta: { g: 'svg2lottie' },
      fr: fps,
      ip: 0,
      op: frames,
      w: vp.width,
      h: vp.height,
      nm: name,
      ddd: 0,
      assets: ctx.assets,
      layers,
      markers: [],
    },
    options.precision ?? 3,
  );
  return {
    animation,
    warnings: warnings.list,
    stats: {
      width: vp.width,
      height: vp.height,
      fps,
      durationSeconds: duration,
      frames,
      layers: layers.length,
      animatedProperties: ctx.animatedProperties,
      keyframes: ctx.keyframes,
    },
  };
}
