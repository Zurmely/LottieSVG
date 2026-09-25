import type { Font as FkFont, Glyph } from 'fontkit';
import type { SvgNode } from './document.js';
import { GENERIC_FAMILIES, parseFontFamilyList, parseFontStyle, parseFontWeight, type FontLibrary, type FontMatch } from './fonts.js';
import { parsePathData, pathBBox } from './path.js';
import type { PathData } from './types.js';
import type { WarningCollector } from './warnings.js';

export interface GlyphShape {
  char: string;
  path: PathData;
}

export interface TextRun {
  /** element whose computed style paints this run (text, tspan or a) */
  node: SvgNode;
  glyphs: GlyphShape[];
}

export interface TextLayout {
  /** the rendered string after whitespace processing */
  text: string;
  runs: TextRun[];
  /** [x, y, width, height] of all glyph outlines */
  bbox: number[];
  /** pen origin of every glyph (after text-anchor), for diagnostics and tests */
  origins: { char: string; x: number; y: number }[];
}

export interface TextEnv {
  fonts?: FontLibrary;
  warnings: WarningCollector;
  /** resolve a length (px, %, em given font size) */
  length: (value: string | undefined, axis: 'x' | 'y' | 'xy', fontSize: number) => number | null;
}

const SKIP = new Set(['title', 'desc', 'metadata', 'animate', 'animateTransform', 'animateColor', 'animateMotion', 'set', 'style', 'script']);
const TEXT_CONTAINERS = new Set(['text', 'tspan', 'a']);
/** Skia's synthetic oblique: x' = x - y/4 in y-down glyph space. */
const SYNTHETIC_SKEW = 0.25;

interface Char {
  ch: string;
  owner: SvgNode;
  x?: number;
  y?: number;
  dx: number;
  dy: number;
  rotate: number;
}

interface Style {
  families: string[];
  weight: number;
  style: ReturnType<typeof parseFontStyle>;
  size: number;
  letterSpacing: number;
  wordSpacing: number;
  kerning: boolean;
  anchor: 'start' | 'middle' | 'end';
  baseline: string;
  baselineShift: number;
}

function prop(node: SvgNode, name: string): string | undefined {
  return node.props.get(name)?.value;
}

function fontSizeOf(node: SvgNode, env: TextEnv, cache: Map<SvgNode, number>): number {
  const hit = cache.get(node);
  if (hit !== undefined) return hit;
  const parentSize = node.parent ? fontSizeOf(node.parent, env, cache) : 16;
  const raw = node.props.get('font-size');
  let size = parentSize;
  // font-size is inherited as a raw string; only resolve it where it was declared.
  if (raw && raw.origin !== 'inherited' && raw.value) {
    const v = raw.value.trim().toLowerCase();
    const keywords: Record<string, number> = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 };
    if (keywords[v]) size = keywords[v];
    else if (v === 'smaller') size = parentSize / 1.2;
    else if (v === 'larger') size = parentSize * 1.2;
    else if (v.endsWith('%')) size = (parseFloat(v) / 100) * parentSize;
    else size = env.length(v, 'xy', parentSize) ?? parentSize;
  }
  cache.set(node, size);
  return size;
}

function weightOf(node: SvgNode): number {
  const raw = node.props.get('font-weight');
  const parent = node.parent ? weightOf(node.parent) : 400;
  if (!raw || raw.origin === 'inherited') return parent;
  return parseFontWeight(raw.value, parent);
}

function spacing(value: string | undefined, size: number, env: TextEnv): number {
  if (!value || value === 'normal') return 0;
  return env.length(value, 'xy', size) ?? 0;
}

function styleOf(node: SvgNode, env: TextEnv, sizes: Map<SvgNode, number>): Style {
  const size = fontSizeOf(node, env, sizes);
  const anchor = prop(node, 'text-anchor');
  let shift = 0;
  const bs = node.props.get('baseline-shift');
  if (bs && bs.value && bs.origin !== 'inherited') {
    const v = bs.value.trim();
    if (v === 'super') shift = -size / 3;
    else if (v === 'sub') shift = size / 5;
    else if (v !== 'baseline') shift = -(v.endsWith('%') ? (parseFloat(v) / 100) * size : env.length(v, 'xy', size) ?? 0);
  }
  return {
    families: parseFontFamilyList(prop(node, 'font-family') ?? 'serif'),
    weight: weightOf(node),
    style: parseFontStyle(prop(node, 'font-style')),
    size,
    letterSpacing: spacing(prop(node, 'letter-spacing'), size, env),
    wordSpacing: spacing(prop(node, 'word-spacing'), size, env),
    kerning: (prop(node, 'font-kerning') ?? 'auto') !== 'none',
    anchor: anchor === 'middle' || anchor === 'end' ? anchor : 'start',
    baseline: node.props.get('alignment-baseline')?.value ?? prop(node, 'dominant-baseline') ?? 'auto',
    baselineShift: shift,
  };
}

function preserves(node: SvgNode): boolean {
  const ws = prop(node, 'white-space');
  if (ws) return /^(pre|pre-wrap|break-spaces)$/.test(ws.trim());
  return prop(node, 'xml:space') === 'preserve';
}

/** Flatten text content in document order, applying CSS white-space collapsing across element boundaries. */
function collectChars(root: SvgNode, env: TextEnv): Char[] {
  const chars: Char[] = [];
  const walk = (node: SvgNode) => {
    for (const item of node.content) {
      if (typeof item === 'string') {
        const keep = preserves(node);
        for (const ch of Array.from(item.replace(/\r\n?/g, '\n'))) {
          const c = /[\n\t]/.test(ch) ? ' ' : ch;
          if (!keep && c === ' ') {
            const prev = chars[chars.length - 1];
            if (!prev || (prev.ch === ' ' && !preserves(prev.owner))) continue;
          }
          chars.push({ ch: c, owner: node, dx: 0, dy: 0, rotate: 0 });
        }
      } else if (TEXT_CONTAINERS.has(item.tagName)) {
        if (prop(item, 'display') === 'none') continue;
        walk(item);
      } else if (item.tagName === 'textPath') {
        env.warnings.add('text-path', '<textPath> is not supported; its text was skipped', root.label);
      } else if (item.tagName === 'tref') {
        env.warnings.add('text-tref', '<tref> is not supported', root.label);
      } else if (!SKIP.has(item.tagName)) {
        env.warnings.add('text-child', `<${item.tagName}> inside <text> is not rendered`, root.label);
      }
    }
  };
  walk(root);
  while (chars.length && chars[chars.length - 1].ch === ' ' && !preserves(chars[chars.length - 1].owner)) chars.pop();
  return chars;
}

function lengthList(node: SvgNode, name: string, axis: 'x' | 'y' | 'xy', size: number, env: TextEnv): number[] {
  const raw = node.attrs.get(name);
  if (!raw) return [];
  return raw
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((v) => (name === 'rotate' ? parseFloat(v) : env.length(v, axis, size) ?? 0));
}

/** Assign x/y/dx/dy/rotate lists: each element's values address its own descendant characters, inner overriding outer. */
function assignPositions(root: SvgNode, chars: Char[], env: TextEnv, sizes: Map<SvgNode, number>): void {
  const isInside = (owner: SvgNode, el: SvgNode) => {
    for (let n: SvgNode | null = owner; n; n = n.parent) if (n === el) return true;
    return false;
  };
  const visit = (el: SvgNode) => {
    const idx = chars.map((c, i) => (isInside(c.owner, el) ? i : -1)).filter((i) => i >= 0);
    const size = fontSizeOf(el, env, sizes);
    const xs = lengthList(el, 'x', 'x', size, env);
    const ys = lengthList(el, 'y', 'y', size, env);
    const dxs = lengthList(el, 'dx', 'x', size, env);
    const dys = lengthList(el, 'dy', 'y', size, env);
    const rs = lengthList(el, 'rotate', 'xy', size, env);
    idx.forEach((ci, k) => {
      const c = chars[ci];
      if (k < xs.length) c.x = xs[k];
      if (k < ys.length) c.y = ys[k];
      if (k < dxs.length) c.dx = dxs[k];
      if (k < dys.length) c.dy = dys[k];
      if (rs.length) c.rotate = rs[Math.min(k, rs.length - 1)];
    });
    if (el.attrs.has('textLength')) env.warnings.add('text-length', 'textLength/lengthAdjust is not supported; natural glyph widths are used', root.label);
    if (el.attrs.has('transform') && el !== root) env.warnings.add('tspan-transform', 'transform on <tspan> is ignored (as browsers do)', root.label);
    for (const c of el.children) if (TEXT_CONTAINERS.has(c.tagName)) visit(c);
  };
  visit(root);
}

/** Baseline offsets as Blink computes them: ascent/descent are rounded to whole pixels at the font size. */
function baselineOffset(font: FkFont, baseline: string, scale: number): number {
  const ascent = Math.round(font.ascent * scale);
  const descent = Math.round(-font.descent * scale);
  switch (baseline.trim()) {
    case 'middle': {
      const xh = font.xHeight || (font.glyphForCodePoint(0x78)?.bbox?.maxY ?? font.ascent / 2);
      return (xh / 2) * scale;
    }
    case 'central':
      return (ascent - descent) / 2;
    case 'hanging':
      return ascent * 0.8;
    case 'mathematical':
      return ascent / 2;
    case 'text-before-edge':
    case 'before-edge':
      return ascent;
    case 'text-after-edge':
    case 'after-edge':
    case 'ideographic':
      return -descent;
    default:
      return 0;
  }
}

function glyphPath(glyph: Glyph, ox: number, oy: number, scale: number, skew: number, rotateDeg: number): PathData {
  const cmds = glyph.path.commands as { command: string; args: number[] }[];
  if (!cmds.length) return [];
  const r = (rotateDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const pt = (fx: number, fy: number): string => {
    const lx = fx * scale + skew * fy * scale;
    const ly = -fy * scale;
    const x = ox + lx * cos - ly * sin;
    const y = oy + lx * sin + ly * cos;
    return `${+x.toFixed(4)} ${+y.toFixed(4)}`;
  };
  let d = '';
  for (const { command, args } of cmds) {
    if (command === 'moveTo') d += `M${pt(args[0], args[1])}`;
    else if (command === 'lineTo') d += `L${pt(args[0], args[1])}`;
    else if (command === 'quadraticCurveTo') d += `Q${pt(args[0], args[1])} ${pt(args[2], args[3])}`;
    else if (command === 'bezierCurveTo') d += `C${pt(args[0], args[1])} ${pt(args[2], args[3])} ${pt(args[4], args[5])}`;
    else if (command === 'closePath') d += 'Z';
  }
  return parsePathData(d);
}

interface Placed {
  owner: SvgNode;
  char: string;
  path: PathData;
  chunk: number;
  x: number;
  y: number;
}

/**
 * Lay out an SVG <text> element into glyph outlines. Returns null (after warning) when no font is
 * available: text is never rasterized.
 */
export function layoutText(root: SvgNode, env: TextEnv): TextLayout | null {
  const chars = collectChars(root, env);
  const text = chars.map((c) => c.ch).join('');
  if (!text.trim()) return null;
  const sizes = new Map<SvgNode, number>();
  assignPositions(root, chars, env, sizes);

  const styles = new Map<SvgNode, Style>();
  const styleFor = (n: SvgNode) => {
    let s = styles.get(n);
    if (!s) styles.set(n, (s = styleOf(n, env, sizes)));
    return s;
  };

  for (const n of new Set(chars.map((c) => c.owner))) {
    const dir = prop(n, 'direction');
    if (dir === 'rtl') env.warnings.add('text-direction', 'direction: rtl is not supported; text laid out left-to-right', root.label);
    const wm = prop(n, 'writing-mode');
    if (wm && !/^(horizontal-tb|lr|lr-tb|rl|rl-tb)$/.test(wm)) env.warnings.add('text-vertical', `writing-mode: ${wm} is not supported`, root.label);
    const deco = n.props.get('text-decoration')?.value;
    if (deco && deco !== 'none') env.warnings.add('text-decoration', 'text-decoration (underline/line-through) is not supported', root.label);
    const variant = prop(n, 'font-variant');
    if (variant && variant !== 'normal') env.warnings.add('font-variant', `font-variant: ${variant} is not supported`, root.label);
    for (const a of ['x', 'y', 'dx', 'dy', 'rotate', 'font-size', 'letter-spacing', 'word-spacing', 'textLength']) {
      if (n.props.get(a)?.anims.length) env.warnings.add('text-animation', `Animated ${a} on text is not supported; the first frame is used`, root.label);
    }
  }
  if (/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(text)) env.warnings.add('text-bidi', 'Right-to-left scripts are not supported; glyph order may be wrong', root.label);

  // Resolve a font per character (browser-style fallback through the family list).
  const missingFamilies = new Set<string>();
  const fontFor = new Map<string, FontMatch | null>();
  const canonical = new Map<string, FontMatch>();
  const resolve = (c: Char): FontMatch | null => {
    const s = styleFor(c.owner);
    const cp = c.ch.codePointAt(0)!;
    for (const fam of s.families) {
      if (GENERIC_FAMILIES.has(fam.toLowerCase())) continue;
      const key = `${fam}|${s.weight}|${s.style}|${c.ch === ' ' ? 32 : cp}`;
      if (!fontFor.has(key)) {
        const found = env.fonts?.match(fam, s.weight, s.style, cp) ?? null;
        // Share one match object per face+weight so shaping segments aren't split per character.
        const id = found && `${found.face.family}|${found.face.weightRange}|${found.face.style}|${found.face.data.byteLength}|${found.weight}|${found.syntheticItalic}`;
        if (id && !canonical.has(id)) canonical.set(id, found!);
        fontFor.set(key, id ? canonical.get(id)! : null);
      }
      const m = fontFor.get(key)!;
      if (!m) {
        missingFamilies.add(`${fam} ${s.weight}${s.style !== 'normal' ? ` ${s.style}` : ''}`);
        continue;
      }
      if (c.ch === ' ' || m.font.hasGlyphForCodePoint(cp)) return m;
    }
    return null;
  };
  const matches = chars.map(resolve);
  const unresolved = chars.filter((c, i) => !matches[i] && c.ch !== ' ');
  if (unresolved.length === chars.filter((c) => c.ch !== ' ').length) {
    const families = [...new Set(chars.flatMap((c) => styleFor(c.owner).families))];
    const named = families.filter((f) => !GENERIC_FAMILIES.has(f.toLowerCase()));
    const what = missingFamilies.size ? [...missingFamilies].join(', ') : named.length ? named.join(', ') : families.join(', ');
    env.warnings.add(
      'font-missing',
      named.length
        ? `Font not found: ${what}. Text "${truncate(text)}" was not converted; provide the font (--fonts, upload) or enable Google Fonts`
        : `Only generic font families (${what}) are specified for "${truncate(text)}"; name a concrete font family or provide one`,
      root.label,
    );
    return null;
  }
  if (unresolved.length) {
    env.warnings.add('glyph-missing', `No available font has glyphs for "${[...new Set(unresolved.map((c) => c.ch))].join('')}"; those characters were skipped`, root.label);
  }
  for (const m of new Set(matches.filter(Boolean) as FontMatch[])) {
    if (m.syntheticItalic) env.warnings.info('font-synthetic-italic', `No italic face for ${m.face.family}; slanted the regular face like browsers do`, root.label);
    if (m.syntheticBold) env.warnings.add('font-synthetic-bold', `No bold face for ${m.face.family} (using ${m.weight}); browsers fake bold, outlines here are thinner`, root.label);
  }

  // Shape segments: runs of characters sharing owner and font with no explicit repositioning inside.
  const placed: Placed[] = [];
  const chunkWidths: { start: number; end: number; anchor: Style['anchor'] }[] = [];
  let penX = 0;
  let penY = 0;
  let chunk = -1;
  let i = 0;
  while (i < chars.length) {
    const c0 = chars[i];
    if (c0.x !== undefined || c0.y !== undefined || chunk < 0) {
      if (c0.x !== undefined) penX = c0.x;
      if (c0.y !== undefined) penY = c0.y;
      chunk++;
      chunkWidths.push({ start: penX, end: penX, anchor: styleFor(c0.owner).anchor });
    }
    const m0 = matches[i];
    let j = i + 1;
    while (
      j < chars.length &&
      chars[j].owner === c0.owner &&
      matches[j] === m0 &&
      chars[j].x === undefined &&
      chars[j].y === undefined &&
      chars[j].dx === 0 &&
      chars[j].dy === 0
    )
      j++;
    const seg = chars.slice(i, j);
    const s = styleFor(c0.owner);
    penX += c0.dx;
    penY += c0.dy;
    if (!m0) {
      i = j;
      continue;
    }
    const font = m0.font;
    const scale = s.size / font.unitsPerEm;
    const features: Record<string, boolean> = {};
    if (!s.kerning) features.kern = false;
    // Browsers disable optional ligatures when letter-spacing is set.
    if (s.letterSpacing !== 0) Object.assign(features, { liga: false, clig: false, dlig: false });
    const str = seg.map((c) => c.ch).join('');
    const run = font.layout(str, features as never);
    const skew = m0.syntheticItalic ? SYNTHETIC_SKEW : 0;
    const shift = baselineOffset(font, s.baseline, scale) + s.baselineShift;
    let ci = 0;
    run.glyphs.forEach((g, gi) => {
      const pos = run.positions[gi];
      const cluster = Math.max(1, g.codePoints?.length ?? 1);
      const chIdx = Math.min(ci, seg.length - 1);
      const ch = seg.slice(chIdx, chIdx + cluster).map((c) => c.ch).join('');
      const path = glyphPath(g, penX + pos.xOffset * scale, penY + shift - pos.yOffset * scale, scale, skew, seg[chIdx].rotate);
      placed.push({ owner: c0.owner, char: ch, path, chunk, x: penX, y: penY });
      penX += pos.xAdvance * scale + s.letterSpacing * cluster + (ch === ' ' ? s.wordSpacing : 0);
      penY -= pos.yAdvance * scale;
      ci += cluster;
    });
    chunkWidths[chunk].end = penX;
    i = j;
  }

  // text-anchor applies per chunk (each absolutely positioned character starts a new chunk).
  for (const p of placed) {
    const cw = chunkWidths[p.chunk];
    const width = cw.end - cw.start;
    const dx = cw.anchor === 'middle' ? -width / 2 : cw.anchor === 'end' ? -width : 0;
    if (dx) {
      p.path = p.path.map((sp) => ({ ...sp, v: sp.v.map(([x, y]) => [x + dx, y] as [number, number]) }));
      p.x += dx;
    }
  }

  const runs: TextRun[] = [];
  for (const p of placed) {
    if (!p.path.length) continue;
    const last = runs[runs.length - 1];
    if (last && last.node === p.owner) last.glyphs.push({ char: p.char, path: p.path });
    else runs.push({ node: p.owner, glyphs: [{ char: p.char, path: p.path }] });
  }
  const all = placed.flatMap((p) => p.path);
  const b = pathBBox(all);
  return { text, runs, bbox: [b.x, b.y, b.width, b.height], origins: placed.map((p) => ({ char: p.char, x: p.x, y: p.y })) };
}

export function truncate(s: string, n = 48): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Fonts a document asks for, so callers can fetch them (e.g. from Google Fonts) before converting. */
export interface FontRequest {
  families: string[];
  weight: number;
  style: ReturnType<typeof parseFontStyle>;
  /** sample of the characters drawn with this request */
  text: string;
}

export function collectFontRequests(root: SvgNode, env: Omit<TextEnv, 'fonts'>): FontRequest[] {
  const out = new Map<string, FontRequest>();
  const sizes = new Map<SvgNode, number>();
  const walk = (n: SvgNode) => {
    if (n.tagName === 'text') {
      for (const c of collectChars(n, { ...env, warnings: env.warnings })) {
        if (c.ch === ' ') continue;
        const s = styleOf(c.owner, env, sizes);
        const key = `${s.families.join(',')}|${s.weight}|${s.style}`;
        const r = out.get(key) ?? { families: s.families, weight: s.weight, style: s.style, text: '' };
        if (!r.text.includes(c.ch)) r.text += c.ch;
        out.set(key, r);
      }
      return;
    }
    n.children.forEach(walk);
  };
  walk(root);
  return [...out.values()];
}
