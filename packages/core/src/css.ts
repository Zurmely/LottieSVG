import * as csstree from 'css-tree';
import type { WarningCollector } from './warnings.js';

export interface Declaration {
  property: string;
  value: string;
  important: boolean;
}

export interface StyleRule {
  selectors: ParsedSelector[];
  declarations: Declaration[];
  order: number;
}

export interface CssKeyframe {
  offsets: number[];
  declarations: Declaration[];
}

export interface Stylesheet {
  rules: StyleRule[];
  keyframes: Map<string, CssKeyframe[]>;
}

interface Compound {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: { name: string; value?: string }[];
}

export interface ParsedSelector {
  /** compounds from left to right, joined by descendant/child combinators */
  parts: { compound: Compound; combinator: ' ' | '>' }[];
  specificity: number;
  text: string;
}

export interface MatchableElement {
  tagName: string;
  getAttribute(name: string): string | null;
  parent: MatchableElement | null;
}

function parseCompound(text: string): Compound | null {
  const c: Compound = { classes: [], attrs: [] };
  const re = /(\*)|([a-zA-Z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[\s*([\w-:]+)\s*(?:=\s*["']?([^"'\]]*)["']?)?\s*\]|(:{1,2}[\w-]+(?:\([^)]*\))?)/gy;
  let pos = 0;
  while (pos < text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) return null;
    if (m[2]) c.tag = m[2];
    else if (m[3]) c.id = m[3];
    else if (m[4]) c.classes.push(m[4]);
    else if (m[5]) c.attrs.push({ name: m[5], value: m[6] });
    else if (m[7]) return null;
    pos = re.lastIndex;
  }
  return c;
}

export function parseSelector(text: string): ParsedSelector | null {
  const tokens = text.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/);
  const parts: ParsedSelector['parts'] = [];
  let combinator: ' ' | '>' = ' ';
  let spec = 0;
  for (const tok of tokens) {
    if (tok === '>') {
      combinator = '>';
      continue;
    }
    if (tok === '+' || tok === '~') return null;
    const compound = parseCompound(tok);
    if (!compound) return null;
    spec += (compound.id ? 10000 : 0) + (compound.classes.length + compound.attrs.length) * 100 + (compound.tag ? 1 : 0);
    parts.push({ compound, combinator });
    combinator = ' ';
  }
  if (!parts.length) return null;
  return { parts, specificity: spec, text };
}

function matchCompound(c: Compound, el: MatchableElement): boolean {
  if (c.tag && c.tag !== el.tagName) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  if (c.classes.length) {
    const cls = (el.getAttribute('class') ?? '').split(/\s+/);
    if (!c.classes.every((k) => cls.includes(k))) return false;
  }
  for (const a of c.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null || (a.value !== undefined && v !== a.value)) return false;
  }
  return true;
}

export function matchSelector(sel: ParsedSelector, el: MatchableElement): boolean {
  const parts = sel.parts;
  let i = parts.length - 1;
  if (!matchCompound(parts[i].compound, el)) return false;
  let node: MatchableElement | null = el;
  while (i > 0) {
    const comb = parts[i].combinator;
    i--;
    node = node!.parent;
    if (comb === '>') {
      if (!node || !matchCompound(parts[i].compound, node)) return false;
    } else {
      while (node && !matchCompound(parts[i].compound, node)) node = node.parent;
      if (!node) return false;
    }
  }
  return true;
}

function declarationsFromBlock(block: csstree.Block | csstree.DeclarationList): Declaration[] {
  const out: Declaration[] = [];
  block.children.forEach((node) => {
    if (node.type !== 'Declaration') return;
    out.push({
      property: node.property.toLowerCase(),
      value: typeof node.value === 'string' ? node.value : csstree.generate(node.value).trim(),
      important: Boolean(node.important),
    });
  });
  return out;
}

export function parseInlineStyle(style: string): Declaration[] {
  try {
    const ast = csstree.parse(style, { context: 'declarationList', parseValue: false }) as csstree.DeclarationList;
    return declarationsFromBlock(ast);
  } catch {
    return [];
  }
}

function parseKeyframeOffsets(prelude: string): number[] {
  return prelude
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .map((s) => (s === 'from' ? 0 : s === 'to' ? 1 : parseFloat(s) / 100))
    .filter((n) => Number.isFinite(n));
}

export function parseStylesheet(css: string, warnings: WarningCollector): Stylesheet {
  const sheet: Stylesheet = { rules: [], keyframes: new Map() };
  let ast: csstree.CssNode;
  try {
    ast = csstree.parse(css, { parseValue: false, parseRulePrelude: false, parseAtrulePrelude: false });
  } catch (e) {
    warnings.add('css-parse', `Could not parse <style>: ${(e as Error).message}`);
    return sheet;
  }
  let order = 0;
  const visit = (list: csstree.List<csstree.CssNode>) => {
    list.forEach((node) => {
      if (node.type === 'Rule') {
        const prelude = csstree.generate(node.prelude);
        const selectors: ParsedSelector[] = [];
        for (const part of splitTopLevel(prelude, ',')) {
          const s = parseSelector(part);
          if (s) selectors.push(s);
          else warnings.add('css-selector', `Unsupported CSS selector "${part.trim()}" ignored`);
        }
        if (selectors.length) sheet.rules.push({ selectors, declarations: declarationsFromBlock(node.block), order: order++ });
      } else if (node.type === 'Atrule') {
        const name = node.name.toLowerCase();
        if (name === 'keyframes' || name === '-webkit-keyframes') {
          const kfName = node.prelude ? csstree.generate(node.prelude).trim().replace(/^["']|["']$/g, '') : '';
          const frames: CssKeyframe[] = [];
          node.block?.children.forEach((child) => {
            if (child.type !== 'Rule') return;
            frames.push({ offsets: parseKeyframeOffsets(csstree.generate(child.prelude)), declarations: declarationsFromBlock(child.block) });
          });
          sheet.keyframes.set(kfName, frames);
        } else if (name === 'media' || name === 'supports') {
          const prelude = node.prelude ? csstree.generate(node.prelude) : '';
          if (/prefers-reduced-motion/.test(prelude)) {
            warnings.info('css-media', `@media ${prelude} block ignored (reduced-motion variant)`);
          } else if (node.block) {
            warnings.add('css-media', `@${name} ${prelude} applied unconditionally`);
            visit(node.block.children);
          }
        } else if (name !== 'import' && name !== 'font-face' && name !== 'charset') {
          warnings.add('css-atrule', `Unsupported at-rule @${name} ignored`);
        }
      }
    });
  };
  if (ast.type === 'StyleSheet') visit(ast.children);
  return sheet;
}

/** Split on a separator, ignoring separators inside parentheses. */
export function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export interface CssAnimationSpec {
  name: string;
  duration: number;
  timingFunction: string;
  delay: number;
  iterationCount: number;
  direction: 'normal' | 'reverse' | 'alternate' | 'alternate-reverse';
  fillMode: 'none' | 'forwards' | 'backwards' | 'both';
  playState: 'running' | 'paused';
}

export function parseTime(s: string): number | null {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(ms|s)$/i.exec(s.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2].toLowerCase() === 'ms' ? n / 1000 : n;
}

const DIRECTIONS = new Set(['normal', 'reverse', 'alternate', 'alternate-reverse']);
const FILLS = new Set(['none', 'forwards', 'backwards', 'both']);
const TIMING_KEYWORDS = new Set(['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end']);

function tokenizeValue(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function defaultSpec(): CssAnimationSpec {
  return { name: 'none', duration: 0, timingFunction: 'ease', delay: 0, iterationCount: 1, direction: 'normal', fillMode: 'none', playState: 'running' };
}

export function parseAnimationShorthand(value: string): CssAnimationSpec[] {
  return splitTopLevel(value, ',').map((part) => {
    const spec = defaultSpec();
    let timeCount = 0;
    for (const tok of tokenizeValue(part)) {
      const lower = tok.toLowerCase();
      const time = parseTime(lower);
      if (time !== null) {
        if (timeCount++ === 0) spec.duration = time;
        else spec.delay = time;
      } else if (TIMING_KEYWORDS.has(lower) || /^(cubic-bezier|steps|linear)\(/.test(lower)) spec.timingFunction = lower;
      else if (lower === 'infinite') spec.iterationCount = Infinity;
      else if (/^\d*\.?\d+$/.test(lower)) spec.iterationCount = parseFloat(lower);
      else if (DIRECTIONS.has(lower) && spec.direction === 'normal' && lower !== 'normal') spec.direction = lower as CssAnimationSpec['direction'];
      else if (FILLS.has(lower) && lower !== 'none') spec.fillMode = lower as CssAnimationSpec['fillMode'];
      else if (lower === 'paused' || lower === 'running') spec.playState = lower;
      else if (lower !== 'normal' && lower !== 'none') spec.name = tok.replace(/^["']|["']$/g, '');
    }
    return spec;
  });
}

/** Resolve `animation` + longhands from an ordered declaration list into animation specs. */
export function resolveAnimations(decls: Map<string, string>): CssAnimationSpec[] {
  let specs: CssAnimationSpec[] = decls.has('animation') ? parseAnimationShorthand(decls.get('animation')!) : [];
  const names = decls.get('animation-name');
  if (names !== undefined) {
    const list = splitTopLevel(names, ',').map((s) => s.trim());
    specs = list.map((n, k) => ({ ...(specs[k] ?? defaultSpec()), name: n }));
  }
  const apply = (prop: string, fn: (spec: CssAnimationSpec, v: string) => void) => {
    const v = decls.get(prop);
    if (v === undefined) return;
    const list = splitTopLevel(v, ',').map((s) => s.trim());
    specs.forEach((spec, k) => fn(spec, list[k % list.length]));
  };
  apply('animation-duration', (s, v) => (s.duration = parseTime(v) ?? 0));
  apply('animation-delay', (s, v) => (s.delay = parseTime(v) ?? 0));
  apply('animation-timing-function', (s, v) => (s.timingFunction = v.toLowerCase()));
  apply('animation-iteration-count', (s, v) => (s.iterationCount = v === 'infinite' ? Infinity : parseFloat(v) || 1));
  apply('animation-direction', (s, v) => (s.direction = (DIRECTIONS.has(v) ? v : 'normal') as CssAnimationSpec['direction']));
  apply('animation-fill-mode', (s, v) => (s.fillMode = (FILLS.has(v) ? v : 'none') as CssAnimationSpec['fillMode']));
  apply('animation-play-state', (s, v) => (s.playState = v === 'paused' ? 'paused' : 'running'));
  return specs.filter((s) => s.name !== 'none');
}
