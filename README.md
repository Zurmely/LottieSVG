# LottieSVG — svg2lottie

Convert animated SVGs exported from **Figma Motion** (CSS `@keyframes` and SMIL `<animate>`/`<animateTransform>`) into **Lottie JSON** and **dotLottie (`.lottie`)** files that play in standard players: lottie-web, lottie-react, and the dotLottie (ThorVG) players.

| Package | What it is |
|---|---|
| [`packages/core`](packages/core) | `@svg2lottie/core`: the converter library (works in Node and the browser) |
| [`packages/cli`](packages/cli) | `svg2lottie` command-line tool |
| [`apps/web`](apps/web) | Local web UI: drag and drop, side-by-side preview, download |
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

Options: `--fps <n>` (default 60), `--precision <n>` (decimals, default 3), `--max-duration <s>` (cap for the unrolled loop, default 30), `--no-blur`, `--pretty`, `--strict` (exit 1 when any warning is reported), `-q/--quiet`.

Every conversion prints a report. Features that cannot be represented produce an explicit warning (for example `Text is not supported; convert text to outlines in Figma before exporting`). They are never dropped silently.

### Web UI

```bash
pnpm dev:web        # http://127.0.0.1:5173
```

Drop an SVG (or pick one from **Examples**). The original SVG, lottie-web and the dotLottie player are driven by one clock, so they stay frame-locked while playing or scrubbing. Download `.json` or `.lottie`, and check the conversion report for warnings.

### Library

```ts
import { convertSvg, toDotLottie } from '@svg2lottie/core';

const { animation, warnings, stats } = convertSvg(svgText, { fps: 60 });
const dotLottieBytes = toDotLottie(animation, { id: 'my-animation' });
```

## Fidelity verification

```bash
pnpm verify packages/core/test/fixtures --frames 24
```

This renders each SVG in headless Chrome with its animations paused and seeked to every sampled frame. It compares that against lottie-web (SVG renderer) and against the `.lottie` archive in the dotLottie player, using pixel diffs. It writes a report and a contact sheet (columns: SVG | lottie-web | dotLottie | diff | diff) to `verify-output/<name>/`. Set `CHROME_PATH` if Chrome is not at `/usr/local/bin/google-chrome`.

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
| Text, images, `<mask>`, patterns, other filters (drop shadows), `animateMotion`, event-based `begin` | Not supported. Reported as warnings |

## Figma Motion specifics

- Figma writes each animated layer's full transform into CSS keyframes (`translate… rotate(rad) scaleX/Y translate(-anchor)`) with `transform-origin: 0 0`. The CSS transform replaces the `transform` attribute. It is mapped directly to Lottie anchor, position, rotation and scale, so rotations beyond 180° and CSS's per-function interpolation are kept.
- Spring and complex easings are pre-baked by Figma as around 60 linear keyframes, and are preserved one-to-one. Simple eases are per-keyframe `cubic-bezier()` and become Lottie bezier handles.
- Corner-radius morphs are SMIL `rx` animations with `keySplines`, which become Lottie rectangle roundness.

## License

MIT
