import { DOMParser } from '@xmldom/xmldom';
import {
  matchSelector,
  parseInlineStyle,
  parseStylesheet,
  parseTime,
  resolveAnimations,
  type Declaration,
  type MatchableElement,
  type Stylesheet,
} from './css.js';
import { parseTimingFunction, type TimingFunction } from './easing.js';
import type { WarningCollector } from './warnings.js';

export interface AnimKeyframe {
  offset: number;
  value: string;
  /** timing of the segment that starts at this keyframe */
  timing: TimingFunction | 'hold';
}

/** A CSS or SMIL animation of a single property, normalized. */
export interface PropAnimation {
  source: 'css' | 'smil';
  property: string;
  keyframes: AnimKeyframe[];
  duration: number;
  delay: number;
  iterations: number;
  direction: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
  fillForwards: boolean;
  fillBackwards: boolean;
  /** SMIL animateTransform only */
  transformType?: 'translate' | 'scale' | 'rotate' | 'skewX' | 'skewY';
  additive: boolean;
  /** SMIL: keyframes with absent 0/100% offsets are filled from the base value */
  implicitEnds?: boolean;
  label: string;
}

export interface PropState {
  value: string | undefined;
  anims: PropAnimation[];
  /** where the static value came from; `css` means a CSS declaration (matters for `transform`) */
  origin?: 'attr' | 'css' | 'inherited';
}

export interface SvgNode extends MatchableElement {
  tagName: string;
  attrs: Map<string, string>;
  parent: SvgNode | null;
  children: SvgNode[];
  text: string;
  props: Map<string, PropState>;
  label: string;
}

const INHERITED = new Set([
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-opacity', 'stroke-width', 'stroke-linecap',
  'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'color', 'visibility',
  'paint-order', 'clip-rule',
]);

const SMIL_TAGS = new Set(['animate', 'animateTransform', 'animateColor', 'set', 'animateMotion']);

/** Figma exports sometimes name stroke width animations after CSS `border-width`. */
const PROPERTY_ALIASES: Record<string, string> = { 'border-width': 'stroke-width' };

function makeNode(el: Element, parent: SvgNode | null): SvgNode {
  const attrs = new Map<string, string>();
  for (let k = 0; k < el.attributes.length; k++) {
    const a = el.attributes[k];
    attrs.set(a.localName === 'href' ? 'href' : a.name, a.value);
  }
  const tagName = el.localName ?? el.tagName;
  const id = attrs.get('id');
  const node: SvgNode = {
    tagName,
    attrs,
    parent,
    children: [],
    text: '',
    props: new Map(),
    label: id ? `${tagName}#${id}` : tagName,
    getAttribute: (name: string) => attrs.get(name) ?? null,
  };
  for (let k = 0; k < el.childNodes.length; k++) {
    const c = el.childNodes[k];
    if (c.nodeType === 1) node.children.push(makeNode(c as Element, node));
    else if (c.nodeType === 3 || c.nodeType === 4) node.text += c.nodeValue ?? '';
  }
  return node;
}

export interface SvgDocument {
  root: SvgNode;
  byId: Map<string, SvgNode>;
  stylesheet: Stylesheet;
  animations: PropAnimation[];
}

export function parseSvgDocument(svg: string, warnings: WarningCollector): SvgDocument {
  const errors: string[] = [];
  const parser = new DOMParser({
    onError: (level: string, msg: string) => {
      if (level !== 'warning') errors.push(msg);
    },
  } as never);
  let doc: Document;
  try {
    doc = parser.parseFromString(svg, 'image/svg+xml') as unknown as Document;
  } catch (e) {
    throw new Error(`Invalid SVG/XML: ${(e as Error).message}`);
  }
  const rootEl = doc.documentElement;
  if (!rootEl || (rootEl.localName ?? rootEl.tagName) !== 'svg') {
    throw new Error(`Invalid SVG: root element is not <svg>${errors.length ? ` (${errors[0]})` : ''}`);
  }
  const root = makeNode(rootEl as unknown as Element, null);
  const byId = new Map<string, SvgNode>();
  const all: SvgNode[] = [];
  const walk = (n: SvgNode) => {
    all.push(n);
    const id = n.attrs.get('id');
    if (id && !byId.has(id)) byId.set(id, n);
    n.children.forEach(walk);
  };
  walk(root);

  const css = all.filter((n) => n.tagName === 'style').map((n) => n.text).join('\n');
  const stylesheet = parseStylesheet(css, warnings);
  const animations: PropAnimation[] = [];
  const cascade = (n: SvgNode) => {
    computeStyle(n, stylesheet, animations, warnings);
    n.children.forEach(cascade);
  };
  cascade(root);
  for (const n of all) if (SMIL_TAGS.has(n.tagName)) collectSmil(n, byId, animations, warnings);
  return { root, byId, stylesheet, animations };
}

function computeStyle(n: SvgNode, sheet: Stylesheet, all: PropAnimation[], warnings: WarningCollector): void {
  const declared = new Map<string, { value: string; origin: 'attr' | 'css' }>();
  for (const [k, v] of n.attrs) {
    if (k === 'style' || k === 'class' || k === 'id') continue;
    declared.set(k, { value: v, origin: 'attr' });
  }
  const matched: { decl: Declaration; spec: number; order: number }[] = [];
  for (const rule of sheet.rules) {
    let best = -1;
    for (const sel of rule.selectors) if (sel.specificity > best && matchSelector(sel, n)) best = sel.specificity;
    if (best >= 0) for (const d of rule.declarations) matched.push({ decl: d, spec: best, order: rule.order });
  }
  const inline = n.attrs.has('style') ? parseInlineStyle(n.attrs.get('style')!) : [];
  inline.forEach((d) => matched.push({ decl: d, spec: 1e9, order: 0 }));
  matched.sort((a, b) => Number(a.decl.important) - Number(b.decl.important) || a.spec - b.spec || a.order - b.order);
  const animationDecls = new Map<string, string>();
  for (const { decl } of matched) {
    const prop = PROPERTY_ALIASES[decl.property] ?? decl.property;
    if (prop.startsWith('animation')) animationDecls.set(prop, decl.value);
    else declared.set(prop, { value: decl.value, origin: 'css' });
  }

  for (const [prop, { value, origin }] of declared) {
    if (value === 'inherit' && n.parent) {
      const p = n.parent.props.get(prop);
      if (p) n.props.set(prop, { ...p, origin: 'inherited' });
      continue;
    }
    n.props.set(prop, { value, anims: [], origin });
  }
  if (n.parent) {
    for (const [prop, state] of n.parent.props) {
      if (INHERITED.has(prop) && !n.props.has(prop)) n.props.set(prop, { value: state.value, anims: state.anims, origin: 'inherited' });
    }
  }

  for (const spec of resolveAnimations(animationDecls)) {
    const frames = sheet.keyframes.get(spec.name);
    if (!frames) {
      warnings.add('css-missing-keyframes', `@keyframes "${spec.name}" not found`, n.label);
      continue;
    }
    if (spec.playState === 'paused') warnings.add('css-paused', `Animation "${spec.name}" is paused; converted as running`, n.label);
    if (spec.duration <= 0) continue;
    const byProp = new Map<string, AnimKeyframe[]>();
    const defaultTiming = parseTimingFunction(spec.timingFunction) ?? parseTimingFunction('ease')!;
    const sorted = frames.flatMap((f) => f.offsets.map((o) => ({ offset: o, decls: f.declarations }))).sort((a, b) => a.offset - b.offset);
    for (const { offset, decls } of sorted) {
      const tf = decls.find((d) => d.property === 'animation-timing-function');
      const timing = (tf && parseTimingFunction(tf.value)) || defaultTiming;
      for (const d of decls) {
        if (d.property === 'animation-timing-function') continue;
        const prop = PROPERTY_ALIASES[d.property] ?? d.property;
        if (!byProp.has(prop)) byProp.set(prop, []);
        const list = byProp.get(prop)!;
        const existing = list.find((k) => k.offset === offset);
        if (existing) {
          existing.value = d.value;
          existing.timing = timing;
        } else list.push({ offset, value: d.value, timing });
      }
    }
    for (const [prop, keyframes] of byProp) {
      const anim: PropAnimation = {
        source: 'css',
        property: prop,
        keyframes,
        duration: spec.duration,
        delay: spec.delay,
        iterations: spec.iterationCount,
        direction: spec.direction,
        fillForwards: spec.fillMode === 'forwards' || spec.fillMode === 'both',
        fillBackwards: spec.fillMode === 'backwards' || spec.fillMode === 'both',
        additive: false,
        implicitEnds: true,
        label: `@keyframes ${spec.name}`,
      };
      all.push(anim);
      addAnimation(n, prop, anim);
      propagate(n, prop);
    }
  }
}

function addAnimation(n: SvgNode, prop: string, anim: PropAnimation): void {
  const state = n.props.get(prop);
  if (!state) n.props.set(prop, { value: undefined, anims: [anim] });
  else if (state.origin === 'inherited') n.props.set(prop, { value: state.value, anims: [...state.anims, anim], origin: 'inherited' });
  else state.anims.push(anim);
}

/** Push an inherited property's animations down to descendants that inherit it. */
function propagate(n: SvgNode, prop: string): void {
  if (!INHERITED.has(prop)) return;
  const state = n.props.get(prop)!;
  for (const c of n.children) {
    const cs = c.props.get(prop);
    if (cs && cs.origin !== 'inherited') continue;
    c.props.set(prop, { value: state.value, anims: state.anims, origin: 'inherited' });
    propagate(c, prop);
  }
}

function parseSmilBegin(s: string | undefined, label: string, warnings: WarningCollector): number {
  if (!s) return 0;
  const first = s.split(';')[0].trim();
  const t = parseClock(first);
  if (t === null) {
    warnings.add('smil-begin', `begin="${s}" (event/syncbase timing) is not supported; starting at 0s`, label);
    return 0;
  }
  return t;
}

export function parseClock(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const withUnit = parseTime(t);
  if (withUnit !== null) return withUnit;
  let m = /^([+-]?\d*\.?\d+)(min|h)$/.exec(t);
  if (m) return parseFloat(m[1]) * (m[2] === 'h' ? 3600 : 60);
  m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t);
  if (m) return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
  if (/^[+-]?\d*\.?\d+$/.test(t)) return parseFloat(t);
  return null;
}

function collectSmil(n: SvgNode, byId: Map<string, SvgNode>, all: PropAnimation[], warnings: WarningCollector): void {
  const href = n.attrs.get('href') ?? n.attrs.get('xlink:href');
  const target = href?.startsWith('#') ? byId.get(href.slice(1)) : n.parent;
  const label = target ? target.label : n.label;
  if (!target) {
    warnings.add('smil-target', `<${n.tagName}> target ${href} not found`);
    return;
  }
  if (n.tagName === 'animateMotion') {
    warnings.add('unsupported-animateMotion', '<animateMotion> is not supported and was ignored', label);
    return;
  }
  const attributeName = n.attrs.get('attributeName');
  if (!attributeName) {
    warnings.add('smil-attribute', `<${n.tagName}> without attributeName ignored`, label);
    return;
  }
  const property = attributeName === 'xlink:href' ? 'href' : attributeName;
  const isSet = n.tagName === 'set';
  let values: string[];
  if (n.attrs.has('values') && !isSet) values = n.attrs.get('values')!.split(';').map((s) => s.trim()).filter((s) => s !== '');
  else if (isSet) values = [n.attrs.get('to') ?? ''];
  else {
    const from = n.attrs.get('from');
    const to = n.attrs.get('to');
    const by = n.attrs.get('by');
    if (to !== undefined) values = from !== undefined ? [from, to] : ['', to];
    else if (by !== undefined) {
      warnings.add('smil-by', `by="${by}" animation treated as from + by for numeric values`, label);
      const base = from ?? target.attrs.get(property) ?? '0';
      const sum = parseFloat(base) + parseFloat(by);
      values = [base, Number.isFinite(sum) ? String(sum) : by];
    } else {
      warnings.add('smil-values', `<${n.tagName} attributeName="${attributeName}"> has no values`, label);
      return;
    }
  }
  const durAttr = n.attrs.get('dur');
  let duration = durAttr && durAttr !== 'indefinite' ? parseClock(durAttr) ?? 0 : 0;
  const delay = parseSmilBegin(n.attrs.get('begin'), label, warnings);
  const repeatCount = n.attrs.get('repeatCount');
  const repeatDur = n.attrs.get('repeatDur');
  let iterations = 1;
  if (repeatCount === 'indefinite' || repeatDur === 'indefinite') iterations = Infinity;
  else if (repeatCount) iterations = parseFloat(repeatCount) || 1;
  else if (repeatDur && duration > 0) iterations = (parseClock(repeatDur) ?? duration) / duration;
  if (isSet && duration === 0) {
    duration = 1e-3;
    iterations = 1;
  }
  if (duration <= 0) {
    warnings.add('smil-dur', `<${n.tagName} attributeName="${attributeName}"> has no usable dur; ignored`, label);
    return;
  }
  const calcMode = isSet ? 'discrete' : n.attrs.get('calcMode') ?? (n.tagName === 'animateMotion' ? 'paced' : 'linear');
  if (calcMode === 'paced') warnings.add('smil-paced', 'calcMode="paced" approximated as linear with even keyTimes', label);
  const count = values.length;
  let keyTimes = n.attrs.get('keyTimes')?.split(';').map((s) => parseFloat(s.trim()));
  if (!keyTimes || keyTimes.length !== count || keyTimes.some((k) => !Number.isFinite(k))) {
    keyTimes = values.map((_, k) => (calcMode === 'discrete' ? k / count : count === 1 ? 0 : k / (count - 1)));
  }
  const splines = n.attrs.get('keySplines')?.split(';').map((s) => s.trim()).filter(Boolean);
  const keyframes: AnimKeyframe[] = values.map((value, k) => {
    let timing: AnimKeyframe['timing'] = { kind: 'bezier', bezier: { x1: 0, y1: 0, x2: 1, y2: 1 } };
    if (calcMode === 'discrete') timing = 'hold';
    else if (calcMode === 'spline' && splines?.[k]) {
      const nums = splines[k].split(/[\s,]+/).map(Number);
      if (nums.length === 4 && nums.every(Number.isFinite)) timing = { kind: 'bezier', bezier: { x1: nums[0], y1: nums[1], x2: nums[2], y2: nums[3] } };
    }
    return { offset: keyTimes![k], value, timing };
  });
  if (calcMode === 'discrete' && keyframes[keyframes.length - 1].offset < 1) {
    keyframes.push({ offset: 1, value: values[values.length - 1], timing: 'hold' });
  }
  if (n.attrs.get('accumulate') === 'sum') warnings.add('smil-accumulate', 'accumulate="sum" is not supported; each repeat restarts', label);
  const additive = n.attrs.get('additive') === 'sum';
  if (additive && n.tagName !== 'animateTransform') warnings.add('smil-additive', 'additive="sum" is only supported on <animateTransform>', label);
  const anim: PropAnimation = {
    source: 'smil',
    property,
    keyframes,
    duration,
    delay,
    iterations,
    direction: 'normal',
    fillForwards: n.attrs.get('fill') === 'freeze' || isSet,
    fillBackwards: false,
    additive,
    label: `<${n.tagName} ${attributeName}>`,
  };
  if (n.tagName === 'animateTransform') {
    const type = (n.attrs.get('type') ?? 'translate') as PropAnimation['transformType'];
    anim.transformType = type;
    anim.property = 'smil-transform';
  }
  all.push(anim);
  addAnimation(target, anim.property, anim);
  propagate(target, anim.property);
}
