/** RGBA with channels in 0..1. */
export type RGBA = [number, number, number, number];

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff',
  gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000',
  lime: '#00ff00', teal: '#008080', navy: '#000080', purple: '#800080', orange: '#ffa500',
  pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee',
  coral: '#ff7f50', salmon: '#fa8072', tomato: '#ff6347', crimson: '#dc143c', khaki: '#f0e68c',
  lavender: '#e6e6fa', beige: '#f5f5dc', ivory: '#fffff0', turquoise: '#40e0d0', tan: '#d2b48c',
  darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
  dimgray: '#696969', whitesmoke: '#f5f5f5', transparent: '#00000000',
};

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function parseChannel(s: string, max: number): number {
  s = s.trim();
  if (s.endsWith('%')) return clamp01(parseFloat(s) / 100);
  return clamp01(parseFloat(s) / max);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** Parse a CSS colour. Returns null for unparseable input (including `none` and `url()`). */
export function parseColor(input: string): RGBA | null {
  let s = input.trim().toLowerCase();
  if (NAMED[s]) s = NAMED[s];
  if (s.startsWith('#')) {
    let hex = s.slice(1);
    if (!/^[0-9a-f]+$/.test(hex)) return null;
    if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    const n = (i: number) => parseInt(hex.slice(i, i + 2), 16) / 255;
    return [n(0), n(2), n(4), hex.length === 8 ? n(6) : 1];
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(s);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const alpha = parts[3] !== undefined ? parseChannel(parts[3], 1) : 1;
    if (fn[1].startsWith('rgb')) {
      return [parseChannel(parts[0], 255), parseChannel(parts[1], 255), parseChannel(parts[2], 255), alpha];
    }
    const [r, g, b] = hslToRgb(parseFloat(parts[0]), parseChannel(parts[1], 100), parseChannel(parts[2], 100));
    return [r, g, b, alpha];
  }
  return null;
}
