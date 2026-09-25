/** Node-only helpers (filesystem font loading and caching). Import from `@svg2lottie/core/node`. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import type { FontLibrary } from './fonts.js';
import type { FontCache, FontFetcher } from './google-fonts.js';

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2', '.ttc', '.otc']);

/** Load every font file under the given directories (recursively). Returns per-file errors instead of throwing. */
export function loadFontDirectories(library: FontLibrary, dirs: string[]): { loaded: string[]; errors: string[] } {
  const loaded: string[] = [];
  const errors: string[] = [];
  const walk = (p: string) => {
    const st = statSync(p, { throwIfNoEntry: false });
    if (!st) {
      errors.push(`Font path not found: ${p}`);
      return;
    }
    if (st.isDirectory()) {
      for (const entry of readdirSync(p).sort()) walk(join(p, entry));
      return;
    }
    if (!FONT_EXTENSIONS.has(extname(p).toLowerCase())) return;
    try {
      library.add(readFileSync(p), { source: p });
      loaded.push(p);
    } catch (e) {
      errors.push((e as Error).message);
    }
  };
  dirs.forEach(walk);
  return { loaded, errors };
}

export function defaultFontCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'svg2lottie', 'fonts');
}

/** Filesystem cache: one file per URL, named by its SHA-1. */
export function fsFontCache(dir = defaultFontCacheDir()): FontCache {
  const file = (key: string) => join(dir, createHash('sha1').update(key).digest('hex'));
  return {
    async get(key) {
      try {
        return new Uint8Array(readFileSync(file(key)));
      } catch {
        return undefined;
      }
    },
    async set(key, data) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file(key), data);
    },
  };
}

/**
 * Fetcher for Node. Without a browser User-Agent the Google Fonts CSS API serves TrueType files, which
 * every font parser handles.
 */
export const nodeFontFetcher: FontFetcher = {
  async fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return res.text();
  },
  async fetchBinary(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};
