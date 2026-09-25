import { getFontRequests } from './convert.js';
import { GENERIC_FAMILIES, type FontLibrary } from './fonts.js';
import { loadGoogleFont, type GoogleFontsOptions } from './google-fonts.js';
import type { FontRequest } from './text.js';

export interface FontResolution {
  request: FontRequest;
  /** family that satisfied the request and where its face came from; null when nothing matched */
  resolved: { family: string; source: string } | null;
}

/**
 * Make sure the library can draw every text request in the SVG. Families already in the library win;
 * otherwise each family in the font-family list is tried on Google Fonts (when enabled), in order.
 */
export async function resolveFonts(svg: string, library: FontLibrary, options: { google?: GoogleFontsOptions | false } = {}): Promise<FontResolution[]> {
  const out: FontResolution[] = [];
  const tried = new Map<string, Promise<boolean>>();
  for (const request of getFontRequests(svg)) {
    let resolved: FontResolution['resolved'] = null;
    for (const family of request.families) {
      if (GENERIC_FAMILIES.has(family.toLowerCase())) continue;
      const probe = request.text.codePointAt(0);
      let match = library.match(family, request.weight, request.style, probe);
      if (match && probe !== undefined && !match.font.hasGlyphForCodePoint(probe)) match = null;
      const exact = match && match.weight === request.weight && !match.syntheticItalic;
      if (!exact && options.google) {
        const key = `${family.toLowerCase()}|${request.weight}|${request.style}`;
        if (!tried.has(key)) tried.set(key, loadGoogleFont(library, family, request.weight, request.style, options.google, request.text).catch(() => false));
        if (await tried.get(key)) match = library.match(family, request.weight, request.style, probe);
      }
      if (match) {
        resolved = { family, source: match.face.source };
        break;
      }
    }
    out.push({ request, resolved });
  }
  return out;
}
