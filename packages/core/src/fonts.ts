import * as fontkit from 'fontkit';

export type FontStyle = 'normal' | 'italic' | 'oblique';

type FkFont = fontkit.Font;

export interface LoadedFace {
  /** family names this face answers to (name table families plus any alias it was registered under) */
  families: string[];
  /** primary family name, used for @font-face in previews */
  family: string;
  /** [min, max]; equal for static fonts, the wght axis range for variable fonts */
  weightRange: [number, number];
  style: FontStyle;
  font: FkFont;
  data: Uint8Array;
  format: 'truetype' | 'opentype' | 'woff' | 'woff2';
  /** where the font came from, e.g. a file path, "upload: X.ttf" or "Google Fonts" */
  source: string;
}

export interface FontMatch {
  face: LoadedFace;
  /** fontkit font instanced at the requested weight for variable fonts */
  font: FkFont;
  weight: number;
  /** a normal face used for italic/oblique text: browsers synthesize a slant */
  syntheticItalic: boolean;
  /** the requested weight is ≥ 600 but the face is ≤ 500: browsers synthesize bold */
  syntheticBold: boolean;
}

export const GENERIC_FAMILIES = new Set([
  'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace',
  'ui-rounded', 'emoji', 'math', 'fangsong', '-apple-system', 'blinkmacsystemfont',
]);

function detectFormat(data: Uint8Array): LoadedFace['format'] | null {
  const tag = String.fromCharCode(data[0], data[1], data[2], data[3]);
  if (tag === 'wOFF') return 'woff';
  if (tag === 'wOF2') return 'woff2';
  if (tag === 'OTTO') return 'opentype';
  if (tag === 'ttcf' || tag === 'true' || (data[0] === 0 && data[1] === 1 && data[2] === 0 && data[3] === 0)) return 'truetype';
  return null;
}

export function normalizeFamily(name: string): string {
  return name.trim().replace(/^["']|["']$/g, '').replace(/\s+/g, ' ').toLowerCase();
}

/** Parse a CSS `font-family` list into family names (quotes removed). */
export function parseFontFamilyList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ',') {
      if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '));
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim().replace(/\s+/g, ' '));
  return out;
}

export function parseFontWeight(value: string | undefined, parentWeight = 400): number {
  const v = (value ?? 'normal').trim().toLowerCase();
  if (v === 'normal') return 400;
  if (v === 'bold') return 700;
  if (v === 'bolder') return parentWeight < 350 ? 400 : parentWeight < 550 ? 700 : 900;
  if (v === 'lighter') return parentWeight < 550 ? 100 : parentWeight < 750 ? 400 : 700;
  const n = parseFloat(v);
  return Number.isFinite(n) ? Math.min(1000, Math.max(1, n)) : 400;
}

export function parseFontStyle(value: string | undefined): FontStyle {
  const v = (value ?? 'normal').trim().toLowerCase();
  if (v.startsWith('italic')) return 'italic';
  if (v.startsWith('oblique')) return 'oblique';
  return 'normal';
}

/** Holds fonts from any source (directory, upload, Google Fonts) and resolves CSS font requests. */
export class FontLibrary {
  readonly faces: LoadedFace[] = [];
  private readonly instances = new Map<string, FkFont>();

  /**
   * Register font data. TrueType collections register every face they contain.
   * Throws with a readable message for unsupported or corrupt files.
   */
  add(input: Uint8Array | ArrayBuffer, options: { source?: string; family?: string; weight?: number; style?: FontStyle } = {}): LoadedFace[] {
    const data = input instanceof Uint8Array ? input : new Uint8Array(input);
    const format = detectFormat(data);
    if (!format) throw new Error(`${options.source ?? 'Font'}: not a TrueType/OpenType/WOFF/WOFF2 font`);
    let parsed: FkFont | fontkit.FontCollection;
    try {
      parsed = fontkit.create(data as never);
    } catch (e) {
      throw new Error(`${options.source ?? 'Font'}: could not be parsed (${(e as Error).message})`);
    }
    const fonts: FkFont[] = 'fonts' in parsed ? (parsed as fontkit.FontCollection).fonts : [parsed as FkFont];
    const added: LoadedFace[] = [];
    for (const font of fonts) {
      const names = new Set<string>();
      const add = (n: unknown) => typeof n === 'string' && n.trim() && names.add(n.trim());
      add(options.family);
      add(font.familyName);
      const nameTable = (font as unknown as { name?: { records?: Record<string, Record<string, string>> } }).name?.records;
      add(nameTable?.preferredFamily?.en);
      add(nameTable?.fontFamily?.en);
      add(font.fullName);
      const os2 = (font as unknown as { 'OS/2'?: { usWeightClass?: number; fsSelection?: { italic?: boolean; oblique?: boolean } } })['OS/2'];
      const sub = (font.subfamilyName ?? '').toLowerCase();
      const style: FontStyle = options.style ?? (os2?.fsSelection?.oblique || sub.includes('oblique') ? 'oblique' : os2?.fsSelection?.italic || sub.includes('italic') ? 'italic' : 'normal');
      const axis = (font.variationAxes as Record<string, { min: number; max: number; default: number }> | undefined)?.wght;
      const staticWeight = options.weight ?? os2?.usWeightClass ?? 400;
      const face: LoadedFace = {
        families: [...names],
        family: [...names][0] ?? 'Unknown',
        weightRange: axis && options.weight === undefined ? [axis.min, axis.max] : [staticWeight, staticWeight],
        style,
        font,
        data,
        format,
        source: options.source ?? 'font',
      };
      const dupe = this.faces.find(
        (f) => f.family === face.family && f.style === face.style && f.weightRange[0] === face.weightRange[0] && f.weightRange[1] === face.weightRange[1],
      );
      if (dupe) {
        for (const n of face.families) if (!dupe.families.includes(n)) dupe.families.push(n);
        added.push(dupe);
        continue;
      }
      this.faces.push(face);
      added.push(face);
    }
    return added;
  }

  hasFamily(family: string): boolean {
    const n = normalizeFamily(family);
    return this.faces.some((f) => f.families.some((x) => normalizeFamily(x) === n));
  }

  /** CSS Fonts §5.2 style and weight matching within one family. */
  match(family: string, weight: number, style: FontStyle): FontMatch | null {
    const n = normalizeFamily(family);
    const candidates = this.faces.filter((f) => f.families.some((x) => normalizeFamily(x) === n));
    if (!candidates.length) return null;
    const styleOrder: FontStyle[] = style === 'italic' ? ['italic', 'oblique', 'normal'] : style === 'oblique' ? ['oblique', 'italic', 'normal'] : ['normal', 'oblique', 'italic'];
    let pool: LoadedFace[] = [];
    for (const s of styleOrder) {
      pool = candidates.filter((f) => f.style === s);
      if (pool.length) break;
    }
    const face = pickWeight(pool, weight);
    const chosenWeight = Math.min(face.weightRange[1], Math.max(face.weightRange[0], weight));
    return {
      face,
      font: this.instance(face, chosenWeight),
      weight: chosenWeight,
      syntheticItalic: style !== 'normal' && face.style === 'normal',
      syntheticBold: weight >= 600 && chosenWeight <= 500,
    };
  }

  private instance(face: LoadedFace, weight: number): FkFont {
    if (face.weightRange[0] === face.weightRange[1]) return face.font;
    const key = `${this.faces.indexOf(face)}@${weight}`;
    let inst = this.instances.get(key);
    if (!inst) {
      inst = face.font.getVariation({ wght: weight });
      this.instances.set(key, inst);
    }
    return inst;
  }
}

function pickWeight(pool: LoadedFace[], desired: number): LoadedFace {
  const covering = pool.find((f) => desired >= f.weightRange[0] && desired <= f.weightRange[1]);
  if (covering) return covering;
  const below = pool.filter((f) => f.weightRange[1] < desired).sort((a, b) => b.weightRange[1] - a.weightRange[1]);
  const above = pool.filter((f) => f.weightRange[0] > desired).sort((a, b) => a.weightRange[0] - b.weightRange[0]);
  if (desired >= 400 && desired <= 500) {
    const upTo500 = above.filter((f) => f.weightRange[0] <= 500);
    return upTo500[0] ?? below[0] ?? above[0];
  }
  if (desired < 400) return below[0] ?? above[0];
  return above[0] ?? below[0];
}
