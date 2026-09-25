# LottieSVG — svg2lottie

Convert animated SVGs exported from **Figma Motion** (CSS `@keyframes` and SMIL `<animate>`/`<animateTransform>`) into **Lottie JSON** and **dotLottie (`.lottie`)** files that play in standard players: lottie-web, lottie-react, and the dotLottie (ThorVG) players.

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | `@svg2lottie/core`: the converter library (works in Node and the browser) |
| [`packages/cli`](packages/cli) | `svg2lottie` command-line tool |
| [`apps/web`](apps/web) | Local web UI: drag and drop, side-by-side preview, download |
| [`packages/a11y`](packages/a11y) | `@svg2lottie/a11y`: tiny helper that labels any Lottie/dotLottie player for screen readers |
| [`packages/visual-verify`](packages/visual-verify) | Frame-by-frame fidelity check against the browser-rendered SVG |

## Quick start

```bash
pnpm install
pnpm build          # builds core + cli
pnpm test           # unit + fixture tests
```

### CLI

```bash
# single file → Lottie JSON (format is inferred from the extension)
node packages/cli/dist/cli.js animation.svg -o animation.json
node packages/cli/dist/cli.js animation.svg -o animation.lottie

# batch: every .svg in a folder (add -r to recurse), both formats
node packages/cli/dist/cli.js exports/ -o out/ --format both

# stdin → stdout
cat animation.svg | node packages/cli/dist/cli.js - > animation.json
```

Options:

- `--fps <n>` (default 60), `--precision <n>` (decimals, default 3), `--max-duration <s>` (cap for the unrolled loop, default 30), `--no-blur`, `--pretty`, `-q/--quiet`.
- `--fonts <dir>` (repeatable): font files used to outline `<text>`.
- `--no-google-fonts`: don't download missing fonts. `--font-cache <dir>` sets the download cache (default `~/.cache/svg2lottie/fonts`).
- `--alt "…"`: accessible label written to the Lottie metadata and dotLottie manifest.
- `--strict`: exit 1 when any warning is reported, including a missing font.

Every conversion prints a report. Features that cannot be represented produce an explicit warning (for example `Font not found: Inter 700. Text "Sale" was not converted`). They are never dropped silently.

### Web UI

```bash
pnpm dev:web        # http://127.0.0.1:5173
```

Drop an SVG (or pick one from **Examples**). The original SVG, lottie-web and the dotLottie player are driven by one clock, so they stay frame-locked while playing or scrubbing. Download `.json` or `.lottie`, and check the conversion report for warnings.

- The **Fonts** panel lists every font the text needs and where each one came from. You can upload font files (or drop them on the page); missing families are fetched from Google Fonts and cached in the browser.
- The **Accessible text** panel shows the extracted label. You can edit it and choose whether it is included in the export.

### Library

```ts
import { convertSvg, toDotLottie } from '@svg2lottie/core';

const { animation, warnings, stats } = convertSvg(svgText, { fps: 60 });
const dotLottieBytes = toDotLottie(animation, { id: 'my-animation' });
```

With text, load fonts first (any mix of sources), then convert:

```ts
import { FontLibrary, convertSvg, resolveFonts } from '@svg2lottie/core';
import { fsFontCache, loadFontDirectories, nodeFontFetcher } from '@svg2lottie/core/node'; // Node only

const fonts = new FontLibrary();
loadFontDirectories(fonts, ['./fonts']);                   // or fonts.add(bytes) in the browser
await resolveFonts(svgText, fonts, { google: { fetcher: nodeFontFetcher, cache: fsFontCache() } });
const { animation, accessibility } = convertSvg(svgText, { fonts, alt: 'Optional label override' });
```

## Text → outlines

`<text>` and `<tspan>` are laid out with the real font (fontkit), then emitted as glyph outlines. The Lottie needs no fonts at runtime and looks the same in every player. Each text element becomes one group, named after its string, with a sub-group per styled run (tspan).

- **Layout:** `font-family` lists with per-character fallback, `font-size` (px/em/%/keywords), `font-weight` (including `bolder`/`lighter`), `font-style`, and the `font` shorthand. Kerning and ligatures (`font-kerning: none` turns kerning off), `letter-spacing` and `word-spacing` (letter-spacing turns optional ligatures off, as in browsers). `text-anchor` per text chunk, `dominant-baseline` and `baseline-shift`, tspan `x`/`y`/`dx`/`dy`/`rotate` lists, and `xml:space`/`white-space` collapsing.
- **Animations:** animations on the text element (transform, opacity, fill, stroke) keep working because they target the group.
- **Font matching:** CSS weight and style matching works for static and variable fonts (TTF, OTF, WOFF, WOFF2, TTC). If there is no italic face, the regular face is slanted as browsers do.
- **Fonts:** fonts come from `--fonts`, web uploads, or Google Fonts (downloaded by family, weight and style, only the unicode-range subsets needed, then cached).
- **Missing fonts:** a missing font produces a `font-missing` warning and the text is skipped. `--strict` fails. There is no raster fallback.
- **Not supported (warned):** `textPath`, `textLength`, text decorations, vertical and RTL text, and animated `x`/`y`/`font-size`.

Measured against Chrome, glyph origins match within 0.02px. `dominant-baseline` offsets follow Blink, including its pixel-rounded ascent and descent.

## Accessibility

Text strings, the root `<title>`/`aria-label`, or `--alt` become the animation's accessible label. It is stored in Lottie `meta.d` / `meta.a11y`, in layer names, and in the dotLottie manifest. `@svg2lottie/a11y` applies it to any player container. See [docs/accessibility.md](docs/accessibility.md) for lottie-web, lottie-react and dotLottie snippets.

## Fidelity verification

```bash
pnpm verify packages/core/test/fixtures --fonts packages/core/test/fonts --frames 24
```

This renders each SVG in headless Chrome with its animations paused and seeked to every sampled frame. It compares that against lottie-web (SVG renderer) and against the `.lottie` archive in the dotLottie player, using pixel diffs. It writes a report and a contact sheet (columns: SVG | lottie-web | dotLottie | diff | diff) to `verify-output/<name>/`. Set `CHROME_PATH` if Chrome is not at `/usr/local/bin/google-chrome`.

Fonts used for text (`--fonts`, plus Google Fonts unless `--no-google-fonts` is set) are also served to the page as `@font-face`. Chrome draws the original `<text>` with exactly the same files, with LCD anti-aliasing turned off to match path rendering. The text fixtures differ by at most 0.51% of pixels.

Two harness behaviours explain some results:

- **Delayed loops:** these convert to their steady-state loop, so for those files the browser is sampled one loop later.
- **Expected mismatches:** fixtures listed in `verify-expectations.json` (the unsupported-features and missing-font demos) are reported as `XFAIL`. This only counts as success if the conversion reported every listed warning.

On the Figma Motion sample, pixelmatch reports at most 0.01% of pixels as different in either player (24 and 60 sampled frames). Fewer than 1% of pixels differ by more than 8/255, which is edge anti-aliasing.

## Supported features

| Feature | Status |
|---|---|
| `path` (all commands incl. arcs), `rect` (+rx/ry), `circle`, `ellipse`, `line`, `polyline`, `polygon`, `g`, `use`, nested `svg` | Supported |
| Fill/stroke colour, `fill-opacity`/`stroke-opacity`, `opacity`, `fill-rule`, caps/joins/miter, `stroke-dasharray` | Supported |
| Linear and radial gradients (userSpace and bbox units, `gradientTransform`, stop opacity, `href` inheritance) | Supported. Elliptical radial gradients are approximated as circular, with a warning |
| Static transforms, `transform-origin` | Supported |
| CSS `@keyframes`: `transform`, `opacity`, `fill`, `stroke`, `*-opacity`, `stroke-width`, `stroke-dashoffset`, geometry | Supported |
| SMIL `animate`/`set`: opacity, colours, stroke width, geometry attributes, `d`/`points` morphing | Supported |
| SMIL `animateTransform` (translate/scale/rotate/skewX, additive) | Supported |
| Easing: linear, `ease*`, `cubic-bezier`, `keySplines`, discrete, `steps()`, `linear()` | Supported |
| Iteration count, delay, direction, fill-mode, mixed durations | Supported by unrolling onto one timeline (loop length = LCM of loop durations) |
| `feGaussianBlur` filter (Figma layer blur) | Lottie Gaussian Blur effect |
| `clip-path` | Canvas-sized clip dropped; shape clips become layer masks |
| `<text>`/`<tspan>` | Outlined with real fonts (see above) |
| Images, `<mask>`, patterns, other filters (drop shadows), `animateMotion`, event-based `begin`, `textPath` | Not supported. Reported as warnings |

## Figma Motion specifics

- Figma writes each animated layer's full transform into CSS keyframes (`translate… rotate(rad) scaleX/Y translate(-anchor)`) with `transform-origin: 0 0`. The CSS transform replaces the `transform` attribute. It is mapped directly to Lottie anchor, position, rotation and scale, so rotations beyond 180° and CSS's per-function interpolation are kept.
- Spring and complex easings are pre-baked by Figma as around 60 linear keyframes, and are preserved one-to-one. Simple eases are per-keyframe `cubic-bezier()` and become Lottie bezier handles.
- Corner-radius morphs are SMIL `rx` animations with `keySplines`, which become Lottie rectangle roundness.

## License

MIT
