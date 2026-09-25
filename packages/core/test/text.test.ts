import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FontLibrary,
  convertSvg,
  fromDotLottie,
  getFontRequests,
  loadGoogleFont,
  memoryFontCache,
  parseFontFamilyList,
  parseGoogleFontsCss,
  resolveFonts,
  toDotLottie,
  withAccessibleLabel,
  type FontFetcher,
} from '../src/index.js';
import { expandFontShorthand, parseSvgDocument } from '../src/document.js';
import { layoutText } from '../src/text.js';
import { WarningCollector } from '../src/warnings.js';

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const fontDir = join(__dirname, 'fonts');
const fixtures = join(__dirname, 'fixtures');
const fontFile = (name: string) => new Uint8Array(readFileSync(join(fontDir, name)));

function roboto(): FontLibrary {
  const lib = new FontLibrary();
  for (const f of readdirSync(fontDir).filter((f) => f.endsWith('.ttf'))) lib.add(fontFile(f), { source: f });
  return lib;
}

/** Lay out the first <text> of an SVG snippet. */
function layout(body: string, lib: FontLibrary | undefined = roboto()) {
  const warnings = new WarningCollector();
  const doc = parseSvgDocument(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200">${body}</svg>`, warnings);
  let text: Obj | undefined;
  const walk = (n: Obj) => {
    if (!text && n.tagName === 'text') text = n;
    n.children.forEach(walk);
  };
  walk(doc.root);
  const env = {
    fonts: lib,
    warnings,
    length: (v: string | undefined, _a: string, fs: number) => {
      if (v === undefined) return null;
      const n = parseFloat(v);
      if (!Number.isFinite(n)) return null;
      return v.trim().endsWith('em') ? n * fs : n;
    },
  };
  return { result: layoutText(text as never, env as never), warnings: warnings.list };
}

const xs = (r: ReturnType<typeof layout>) => r.result!.origins.map((o) => +o.x.toFixed(2));
const find = (items: Obj[], pred: (o: Obj) => boolean): Obj | undefined => {
  for (const it of items) {
    if (pred(it)) return it;
    const nested = it.it ?? it.shapes ?? it.layers;
    if (Array.isArray(nested)) {
      const r = find(nested, pred);
      if (r) return r;
    }
  }
  return undefined;
};

describe('FontLibrary', () => {
  it('registers faces with their family, weight and style', () => {
    const lib = roboto();
    expect(lib.faces.map((f) => [f.family, f.weightRange[0], f.style]).sort()).toEqual([
      ['Roboto', 400, 'italic'],
      ['Roboto', 400, 'normal'],
      ['Roboto', 700, 'normal'],
    ]);
  });

  it('follows CSS weight and style matching', () => {
    const lib = roboto();
    expect(lib.match('roboto', 400, 'normal')!.weight).toBe(400);
    expect(lib.match('Roboto', 600, 'normal')!.weight).toBe(700);
    expect(lib.match('Roboto', 300, 'normal')!.weight).toBe(400);
    const boldItalic = lib.match('Roboto', 700, 'italic')!;
    expect(boldItalic.face.style).toBe('italic');
    expect(boldItalic.syntheticBold).toBe(true);
    expect(lib.match('Nope', 400, 'normal')).toBeNull();
    const only = new FontLibrary();
    only.add(fontFile('Roboto-Regular.ttf'));
    expect(only.match('Roboto', 400, 'italic')!.syntheticItalic).toBe(true);
  });

  it('rejects files that are not fonts with a readable error', () => {
    expect(() => new FontLibrary().add(new TextEncoder().encode('<svg/>'), { source: 'logo.svg' })).toThrow(/logo\.svg: not a TrueType/);
  });

  it('parses font-family lists and the font shorthand', () => {
    expect(parseFontFamilyList(`"Open Sans", 'Roboto', Helvetica Neue, sans-serif`)).toEqual(['Open Sans', 'Roboto', 'Helvetica Neue', 'sans-serif']);
    expect(expandFontShorthand('italic 700 44px/1.2 Roboto, sans-serif')).toMatchObject({ 'font-style': 'italic', 'font-weight': '700', 'font-size': '44px', 'font-family': 'Roboto, sans-serif' });
    expect(expandFontShorthand('bogus')).toBeNull();
  });
});

describe('text layout (expectations measured against Chrome)', () => {
  it('applies kerning and ligatures, and font-kerning: none disables kerning', () => {
    const kerned = layout('<text font-family="Roboto" font-size="100">AV</text>');
    const plain = layout('<text font-family="Roboto" font-size="100" font-kerning="none">AV</text>');
    expect(xs(kerned)[1]).toBeLessThan(xs(plain)[1]);
    const lig = layout('<text font-family="Roboto" font-size="40">office</text>');
    expect(lig.result!.origins.map((o) => o.char)).toEqual(['o', 'ffi', 'c', 'e']);
    // letter-spacing turns optional ligatures off, as browsers do
    const spaced = layout('<text font-family="Roboto" font-size="40" letter-spacing="2">office</text>');
    expect(spaced.result!.origins).toHaveLength(6);
  });

  it('adds letter- and word-spacing after each character', () => {
    const a = xs(layout('<text font-family="Roboto" font-size="20">a b</text>'));
    const b = xs(layout('<text font-family="Roboto" font-size="20" letter-spacing="3" word-spacing="5">a b</text>'));
    expect(b[1] - a[1]).toBeCloseTo(3, 5);
    expect(b[2] - a[2]).toBeCloseTo(3 + 3 + 5, 5);
  });

  it('resolves em letter-spacing against the font size', () => {
    const a = xs(layout('<text font-family="Roboto" font-size="20" letter-spacing="0.1em">ab</text>'));
    const b = xs(layout('<text font-family="Roboto" font-size="20">ab</text>'));
    expect(a[1] - b[1]).toBeCloseTo(2, 5);
  });

  it('anchors each text chunk', () => {
    const start = layout('<text x="200" font-family="Roboto" font-size="20">Hello</text>').result!;
    const mid = layout('<text x="200" font-family="Roboto" font-size="20" text-anchor="middle">Hello</text>').result!;
    const end = layout('<text x="200" font-family="Roboto" font-size="20" text-anchor="end">Hello</text>').result!;
    const width = 200 - end.origins[0].x;
    expect(start.origins[0].x).toBe(200);
    expect(mid.origins[0].x).toBeCloseTo(200 - width / 2, 5);
  });

  it('collapses whitespace unless preserved', () => {
    expect(layout('<text font-family="Roboto">  a \n\t  b  </text>').result!.text).toBe('a b');
    expect(layout('<text font-family="Roboto" xml:space="preserve"> a  b</text>').result!.text).toBe(' a  b');
    expect(layout('<text font-family="Roboto" style="white-space: pre">a  b</text>').result!.text).toBe('a  b');
    expect(layout('<text font-family="Roboto">a <tspan> b</tspan></text>').result!.text).toBe('a b');
  });

  it('positions tspans with x/y/dx/dy lists and rotates glyphs', () => {
    const r = layout('<text x="10 30" y="50" font-family="Roboto" font-size="20">ab<tspan x="100" dy="-5 5">cd</tspan></text>').result!;
    expect(r.origins.map((o) => [+o.x.toFixed(2), +o.y.toFixed(2)]).slice(0, 3)).toEqual([[10, 50], [30, 50], [100, 45]]);
    expect(r.origins[3].y).toBeCloseTo(50, 5);
    const rot = layout('<text font-family="Roboto" font-size="40" rotate="90">I</text>').result!;
    const [x, , w, h] = rot.bbox;
    // clockwise: the upright stem now extends to the right of the origin
    expect(w).toBeGreaterThan(h);
    expect(x).toBeGreaterThan(-1);
  });

  it('shifts dominant baselines like Blink (pixel-rounded ascent/descent)', () => {
    const y = (b: string) => layout(`<text y="100" font-family="Roboto" font-size="100" dominant-baseline="${b}">x</text>`).result!.bbox[1];
    const base = y('auto');
    // Chrome: middle +26.42, central +34.5, hanging +74.4, text-before-edge +93, ideographic -24 (Roboto, 100px)
    expect(y('middle') - base).toBeCloseTo(26.42, 1);
    expect(y('central') - base).toBeCloseTo(34.5, 1);
    expect(y('hanging') - base).toBeCloseTo(74.4, 1);
    expect(y('text-before-edge') - base).toBeCloseTo(93, 1);
    expect(y('ideographic') - base).toBeCloseTo(-24, 1);
    expect(y('text-top') - base).toBe(0);
  });

  it('uses the italic face, and slants the regular face when no italic exists', () => {
    const lib = new FontLibrary();
    lib.add(fontFile('Roboto-Regular.ttf'));
    const r = layout('<text font-family="Roboto" font-size="40" font-style="italic">l</text>', lib);
    expect(r.warnings.some((w) => w.code === 'font-synthetic-italic')).toBe(true);
    const upright = layout('<text font-family="Roboto" font-size="40">l</text>', lib).result!;
    expect(r.result!.bbox[2]).toBeGreaterThan(upright.bbox[2] + 5);
  });

  it('falls back per character through the family list and reports missing glyphs', () => {
    const r = layout('<text font-family="Nope, Roboto" font-size="20">Hi ☃</text>');
    expect(r.result!.origins.map((o) => o.char)).toEqual(['H', 'i', ' ']);
    expect(r.warnings.map((w) => w.code)).toContain('glyph-missing');
  });

  it('never rasterizes: missing fonts return nothing plus a clear warning', () => {
    const r = layout('<text font-family="Imaginary Sans" font-weight="bold">Hello</text>');
    expect(r.result).toBeNull();
    expect(r.warnings[0]).toMatchObject({ code: 'font-missing' });
    expect(r.warnings[0].message).toMatch(/Font not found: Imaginary Sans 700.*"Hello"/);
    const generic = layout('<text font-family="sans-serif">Hi</text>');
    expect(generic.warnings[0].message).toMatch(/Only generic font families \(sans-serif\)/);
  });
});

describe('text conversion', () => {
  it('outlines text into per-element groups named after the text, with runs for tspans', () => {
    const { animation, warnings } = convertSvg(readFileSync(join(fixtures, 'text-basic.svg'), 'utf8'), { fonts: roboto() });
    expect(warnings.filter((w) => w.severity !== 'info')).toEqual([]);
    const names = (animation.layers as Obj[]).map((l) => l.nm);
    expect(names).toContain('Text "Mixed bold and raised back"');
    const mixed = (animation.layers as Obj[]).find((l) => l.nm === 'Text "Mixed bold and raised back"')!;
    const runs = mixed.shapes[0].it.filter((i: Obj) => i.ty === 'gr');
    expect(runs.map((r: Obj) => r.nm)).toEqual(['tspan "back"', 'tspan "raised"', 'Text "and"', 'tspan "bold"', 'Text "Mixed"']);
    const bold = runs.find((r: Obj) => r.nm === 'tspan "bold"');
    expect(bold.it.find((i: Obj) => i.ty === 'fl').c.k.slice(0, 3)).toEqual([0.937, 0.278, 0.435]);
    expect(bold.it.filter((i: Obj) => i.ty === 'sh').map((s: Obj) => s.nm)).toContain('b 2');
  });

  it('keeps CSS and SMIL animations on the text element', () => {
    const { animation } = convertSvg(readFileSync(join(fixtures, 'text-animated.svg'), 'utf8'), { fonts: roboto() });
    const headline = (animation.layers as Obj[]).find((l) => l.nm.startsWith('headline: Text'))!;
    const tr = headline.shapes[0].it.at(-1);
    expect(tr.s.a).toBe(1);
    expect(tr.o.a).toBe(1);
    expect(tr.p.k).toEqual([200, 110]);
    const fill = find(headline.shapes, (o) => o.ty === 'fl')!;
    expect(fill.c.a).toBe(1);
    expect(find(headline.shapes, (o) => o.ty === 'st')).toBeDefined();
  });

  it('warns about missing fonts and still converts everything else', () => {
    const { animation, warnings } = convertSvg(readFileSync(join(fixtures, 'text-missing-font.svg'), 'utf8'), { fonts: roboto() });
    expect(warnings.filter((w) => w.code === 'font-missing')).toHaveLength(2);
    expect((animation.layers as Obj[]).map((l) => l.nm)).toEqual(['rect']);
  });

  it('lists the fonts a document needs', () => {
    const req = getFontRequests(readFileSync(join(fixtures, 'text-figma-style.svg'), 'utf8'));
    expect(req.map((r) => [r.families, r.weight, r.style])).toEqual([
      [['Inter'], 700, 'normal'],
      [['Inter'], 400, 'normal'],
    ]);
  });
});

describe('accessibility metadata', () => {
  it('collects text in document order into meta.d / meta.a11y and the dotLottie manifest', () => {
    const { animation, accessibility } = convertSvg(readFileSync(join(fixtures, 'text-basic.svg'), 'utf8'), { fonts: roboto() });
    expect(accessibility.source).toBe('text');
    expect(accessibility.texts[0].text).toBe('AVATAR To office');
    expect(accessibility.label.startsWith('AVATAR To office Centered bold')).toBe(true);
    expect(animation.meta.d).toBe(accessibility.label);
    expect(animation.meta.a11y.texts).toHaveLength(7);
    const { manifest } = fromDotLottie(toDotLottie(animation));
    expect(manifest).toMatchObject({ description: accessibility.label, accessibility: { source: 'text' } });
  });

  it('prefers --alt, then aria-label, then <title>', () => {
    const svg = readFileSync(join(fixtures, 'text-animated.svg'), 'utf8');
    expect(convertSvg(svg, { fonts: roboto() }).accessibility).toMatchObject({ label: 'Hello Lottie banner', source: 'title' });
    expect(convertSvg(svg, { fonts: roboto(), alt: 'Custom' }).animation.meta.d).toBe('Custom');
    expect(convertSvg(svg.replace('<svg ', '<svg aria-label="Aria wins" '), {}).accessibility.source).toBe('aria-label');
  });

  it('keeps the original strings even when fonts are missing', () => {
    const { accessibility } = convertSvg(readFileSync(join(fixtures, 'text-missing-font.svg'), 'utf8'));
    expect(accessibility.texts).toEqual([]);
    expect(accessibility.source).toBe('none');
  });

  it('can relabel an existing animation', () => {
    const { animation } = convertSvg(readFileSync(join(fixtures, 'text-basic.svg'), 'utf8'), { fonts: roboto() });
    const edited = withAccessibleLabel(animation, 'Promo banner');
    expect(edited.meta).toMatchObject({ d: 'Promo banner', a11y: { label: 'Promo banner', source: 'custom' } });
    expect(animation.meta.d).not.toBe('Promo banner');
    expect(withAccessibleLabel(animation, '').meta.d).toBeUndefined();
  });
});

describe('Google Fonts', () => {
  const css = `@font-face {
  font-family: 'Roboto';
  font-style: normal;
  font-weight: 700;
  src: url(https://fonts.gstatic.com/s/roboto/bold.ttf) format('truetype');
}`;
  const mock = () => {
    const calls: string[] = [];
    const fetcher: FontFetcher = {
      async fetchText(url) {
        calls.push(url);
        if (!url.includes('family=Roboto')) throw new Error('400');
        return css;
      },
      async fetchBinary(url) {
        calls.push(url);
        return fontFile('Roboto-Bold.ttf');
      },
    };
    return { fetcher, calls };
  };

  it('parses the CSS API response', () => {
    expect(parseGoogleFontsCss(css)).toEqual([{ family: 'Roboto', style: 'normal', weight: [700, 700], url: 'https://fonts.gstatic.com/s/roboto/bold.ttf', unicodeRange: undefined }]);
    expect(parseGoogleFontsCss('@font-face{font-family:X;font-weight:100 900;src:url(a.woff2) format("woff2")}')[0].weight).toEqual([100, 900]);
  });

  it('downloads by family/weight/style and caches CSS and font files', async () => {
    const { fetcher, calls } = mock();
    const cache = memoryFontCache();
    const lib = new FontLibrary();
    expect(await loadGoogleFont(lib, 'Roboto', 700, 'normal', { fetcher, cache })).toBe(true);
    expect(calls[0]).toBe('https://fonts.googleapis.com/css2?family=Roboto:wght@700');
    expect(lib.match('Roboto', 700, 'normal')!.face.source).toBe('Google Fonts');
    expect(cache.size()).toBe(2);
    await loadGoogleFont(new FontLibrary(), 'Roboto', 700, 'normal', { fetcher, cache });
    expect(calls).toHaveLength(2);
  });

  it('resolveFonts walks the family list and reports what it could not find', async () => {
    const { fetcher } = mock();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text font-family="Unknown Face, Roboto" font-weight="700">Hi</text><text font-family="Nope">x</text></svg>';
    const lib = new FontLibrary();
    const res = await resolveFonts(svg, lib, { google: { fetcher, cache: memoryFontCache() } });
    expect(res.map((r) => r.resolved)).toEqual([{ family: 'Roboto', source: 'Google Fonts' }, null]);
    expect(convertSvg(svg, { fonts: lib }).warnings.filter((w) => w.code === 'font-missing')).toHaveLength(1);
  });
});
