import type { FontCache, FontFetcher, LoadedFace } from '@svg2lottie/core';

/** Browsers get WOFF2 from the Google Fonts CSS API; fontkit decodes it, so no proxy is needed. */
export const browserFetcher: FontFetcher = {
  async fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    return res.text();
  },
  async fetchBinary(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} for ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};

/** Cache Storage backed font cache, so repeat visits work offline. */
export function browserFontCache(): FontCache | undefined {
  if (typeof caches === 'undefined') return undefined;
  const open = caches.open('svg2lottie-fonts-v1');
  return {
    async get(key) {
      const hit = await (await open).match(key);
      return hit ? new Uint8Array(await hit.arrayBuffer()) : undefined;
    },
    async set(key, data) {
      await (await open).put(key, new Response(data.slice().buffer));
    },
  };
}

const faceUrls = new WeakMap<LoadedFace, string>();

/** @font-face rules for the original-SVG preview, so the browser draws the same glyphs as the Lottie. */
export function fontFaceCss(faces: LoadedFace[]): string {
  return faces
    .flatMap((face) => {
      let url = faceUrls.get(face);
      if (!url) {
        url = URL.createObjectURL(new Blob([face.data.slice().buffer], { type: `font/${face.format === 'truetype' ? 'ttf' : face.format === 'opentype' ? 'otf' : face.format}` }));
        faceUrls.set(face, url);
      }
      return face.families.map(
        (family) => `@font-face{font-family:${JSON.stringify(family)};src:url(${url}) format('${face.format}');font-weight:${face.weightRange[0]} ${face.weightRange[1]};font-style:${face.style}}`,
      );
    })
    .join('\n');
}

export const FONT_FILE_RE = /\.(ttf|otf|woff2?|ttc|otc)$/i;
