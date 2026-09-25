import type { FontLibrary, FontStyle } from './fonts.js';

export interface FontFetcher {
  fetchText(url: string): Promise<string>;
  fetchBinary(url: string): Promise<Uint8Array>;
}

/** Byte cache keyed by URL. Implementations: filesystem (CLI), Cache Storage (web), memory (tests). */
export interface FontCache {
  get(key: string): Promise<Uint8Array | undefined>;
  set(key: string, data: Uint8Array): Promise<void>;
}

export interface GoogleFontsOptions {
  fetcher: FontFetcher;
  cache?: FontCache;
  /** default https://fonts.googleapis.com */
  cssBase?: string;
}

export interface GoogleFace {
  family: string;
  style: FontStyle;
  weight: [number, number];
  url: string;
  unicodeRange?: string;
}

export function googleFontsCssUrl(family: string, weight: number, style: FontStyle, cssBase = 'https://fonts.googleapis.com'): string {
  const fam = encodeURIComponent(family).replace(/%20/g, '+');
  const w = Math.round(weight);
  return style === 'normal' ? `${cssBase}/css2?family=${fam}:wght@${w}` : `${cssBase}/css2?family=${fam}:ital,wght@1,${w}`;
}

export function parseGoogleFontsCss(css: string): GoogleFace[] {
  const out: GoogleFace[] = [];
  for (const block of css.match(/@font-face\s*{[^}]*}/g) ?? []) {
    const prop = (name: string) => new RegExp(`${name}\\s*:\\s*([^;}]+)`).exec(block)?.[1].trim();
    const url = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(prop('src') ?? '')?.[1];
    if (!url) continue;
    const [w0, w1] = (prop('font-weight') ?? '400').split(/\s+/).map(Number);
    out.push({
      family: (prop('font-family') ?? '').replace(/^['"]|['"]$/g, ''),
      style: (prop('font-style') ?? 'normal') === 'normal' ? 'normal' : 'italic',
      weight: [w0, Number.isFinite(w1) ? w1 : w0],
      url,
      unicodeRange: prop('unicode-range'),
    });
  }
  return out;
}

async function cached(key: string, cache: FontCache | undefined, load: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const hit = await cache?.get(key).catch(() => undefined);
  if (hit) return hit;
  const data = await load();
  await cache?.set(key, data).catch(() => undefined);
  return data;
}

/**
 * Download one family/weight/style from Google Fonts into the library. Returns false when Google does not
 * serve that family (the caller then tries the next family in the font-family list).
 */
export async function loadGoogleFont(library: FontLibrary, family: string, weight: number, style: FontStyle, options: GoogleFontsOptions): Promise<boolean> {
  const url = googleFontsCssUrl(family, weight, style, options.cssBase);
  let css: string;
  try {
    const bytes = await cached(url, options.cache, async () => new TextEncoder().encode(await options.fetcher.fetchText(url)));
    css = new TextDecoder().decode(bytes);
  } catch {
    // Unknown families and unavailable weights are 400s; retry with the family's default weight.
    if (weight === 400 && style === 'normal') return false;
    const fallback = googleFontsCssUrl(family, 400, 'normal', options.cssBase).replace(/:wght@400$/, '');
    try {
      const bytes = await cached(fallback, options.cache, async () => new TextEncoder().encode(await options.fetcher.fetchText(fallback)));
      css = new TextDecoder().decode(bytes);
    } catch {
      return false;
    }
  }
  const faces = parseGoogleFontsCss(css);
  if (!faces.length) return false;
  for (const face of faces) {
    const data = await cached(face.url, options.cache, () => options.fetcher.fetchBinary(face.url));
    // Register under the requested name; static instances from the CSS API carry their weight in the CSS.
    library.add(data, { family: face.family || family, weight: face.weight[0] === face.weight[1] ? face.weight[0] : undefined, style: face.style, source: 'Google Fonts' });
  }
  return true;
}

export function memoryFontCache(): FontCache & { size: () => number } {
  const map = new Map<string, Uint8Array>();
  return {
    get: async (k) => map.get(k),
    set: async (k, v) => void map.set(k, v),
    size: () => map.size,
  };
}
