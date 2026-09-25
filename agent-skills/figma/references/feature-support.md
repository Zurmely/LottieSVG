# Feature support (verified against `packages/core`)

Source of truth: `packages/core/src/convert.ts`, `document.ts`, `timeline.ts`, `easing.ts`, and the tests in `packages/core/test/`. "Warning" means `--strict` fails. "Info" means it passes.

## How Figma Motion encodes animation

Examples are from `packages/core/test/fixtures/figma-motion-sample.svg`:

| Figma property | SVG encoding | Lottie result |
|---|---|---|
| Position / rotation / scale | CSS `@keyframes` `transform: translateX() translateY() translate(a) rotate(<rad>) scaleX() scaleY() translate(-a)` with `transform-origin: 0 0`. It **replaces** the element's `transform` attribute. | Anchor = `a`, and position, rotation (degrees, unwrapped past 180°) and scale are mapped directly |
| Opacity | CSS `opacity` keyframes. The static `opacity` attribute is a snapshot and is overridden. | Transform opacity |
| Stroke width | CSS keyframes named `border-width`, aliased to `stroke-width` | Stroke `w` |
| Corner radius | SMIL `<animate attributeName="rx" calcMode="spline" keySplines=…>` | Rect roundness `r` |
| Simple easing | per-keyframe `animation-timing-function: cubic-bezier()`, with `animation: … linear` | Bezier in/out handles per keyframe |
| Spring / complex easing | about 60 keyframes (roughly every 1.67%) with no timing function | Kept one-to-one as linear keyframes |
| Layer blur | `filter` = `feFlood(opacity 0)` + `feBlend` + `feGaussianBlur` | Layer Gaussian Blur effect (ty 29), blurriness = stdDeviation / 0.3 |
| Frame clip | root `<g clip-path>` with a canvas-sized rect | Dropped (info `trivial-clip`) |

Other transform function lists work too. Matrices are decomposed (info `transform-decomposed`). If keyframes use **different** function lists, you get warning `transform-interp`.

## Supported

- Elements: `path` (all commands, including arcs), `rect` (+`rx`/`ry`), `circle`, `ellipse`, `line`, `polyline`, `polygon`, `g`, `use`, nested `svg`. A rect with different `rx`/`ry` becomes a path.
- Paint: fill/stroke colours including `currentColor`, `fill-opacity`, `stroke-opacity`, `opacity`, `fill-rule`, `stroke-linecap`/`linejoin`/`miterlimit`, `stroke-dasharray` (static), `stroke-dashoffset` (animatable when a dasharray is set), and `paint-order`.
- Gradients: linear and radial, in `userSpaceOnUse` or `objectBoundingBox` units, with `gradientTransform`, stop opacity and `href` inheritance. bbox gradients follow animated geometry.
- Clip paths: static `userSpaceOnUse` shapes become Lottie layer masks. Multiple shapes become additive masks.
- Animatable, through CSS or SMIL: transform, opacity, fill, stroke, `*-opacity`, `stroke-width`, `stroke-dashoffset`, geometry (`x`, `y`, `width`, `height`, `rx`, `ry`, `cx`, `cy`, `r`), and `d` / `points` morphs (CSS `d: path("…")` also works).
- SMIL `animateTransform`: translate, scale, rotate (with centre), skewX, and `additive="sum"`.
- Easing: `linear`, `ease*`, `cubic-bezier`, `keySplines`, discrete/`set`, `steps()` (expanded to holds), and `linear()` with stops.
- Timing: iteration count, delay, `direction` (including alternate), fill-mode, and mixed durations. All are unrolled onto one timeline.

## Timeline, looping and delays (`timeline.ts`, `convert.ts`)

- **Composition length** is the LCM of all infinite loop periods, where an `alternate` loop counts as 2 × its duration. If that LCM exceeds `--max-duration` (default 30s), the converter uses the longest loop and raises warning `loop-mismatch`, and the shorter loops won't line up at the seam. The length is then extended to the end of the longest finite animation (delay + duration × iterations).
- Lottie players loop the whole composition, so every finite animation replays each time the composition restarts.
- **Infinite loop with a delay (positive or negative)**: converted to its steady-state loop, as if it had been running since before frame 0. It becomes a phase offset, and the first cycle's wait is not reproduced. This is info `loop-delay`. Use it for staggered loops. For a visible pause, put hold keyframes inside the loop.
- **Finite animation with a delay**: before the delay it shows the base value, or the first keyframe if `animation-fill-mode` is `backwards`/`both`. Without `forwards`/`both` it snaps back to the base value at the end. Figma Motion one-shots should use `both`.
- **Mixed one-shot and loop**: nothing warns when the loop period doesn't divide the composition length. For example, a 2s loop plus a 5s one-shot makes a 5s composition, and the loop jumps at the seam.
- SMIL `begin` must be a clock value. Event or syncbase begins start at 0 (`smil-begin`). `accumulate="sum"` is ignored (`smil-accumulate`).

## Not supported

| Feature | Code | Severity |
|---|---|---|
| `<text>` (on `main`; see text-and-fonts.md) | `unsupported-text` | warning |
| `<image>`, `<foreignObject>` | `unsupported-image`, `unsupported-foreignObject` | warning |
| `<mask>` | `mask` | warning |
| Pattern fill / missing paint server | `paint-server` | warning |
| Drop/inner shadow, any non-blur filter, CSS filters other than `blur()` | `filter` | warning |
| Animated blur | `filter-animation` | warning |
| `<animateMotion>` | `unsupported-animateMotion` | warning |
| Elliptical/skewed radial gradient, focal point, `spreadMethod` reflect/repeat | `gradient-transform`, `gradient-focal`, `gradient-spread` | warning |
| Animated gradient stops | `gradient-animation` | warning |
| Animated `stroke-dasharray` | `dasharray-animation` | warning |
| Path morph with different structure (becomes a discrete switch) | `path-morph` | warning |
| Animated rect with `rx` ≠ `ry` | `rect-radius` | warning |
| Animated clip-path geometry, `clipPathUnits="objectBoundingBox"` | `clip-animation`, `clip-units` | warning |
| Clip/filter on a nested element inside a flattened group | `nested-layer-feature` | warning |
| Multiple animations on one property | `multiple-animations` | warning |
| `vector-effect="non-scaling-stroke"` | `non-scaling-stroke` | warning |
| `transform-origin` in % with `transform-box` other than `view-box` | `transform-origin` | warning |
| Animated fill starting from `none` | `paint-none` | warning |
| Unknown units (em, etc. are converted at a fixed 16px) | `unit` | warning |
| **Blend modes (`mix-blend-mode`)** | none (silently dropped) | none |
| **CSS `offset-path`, animated `visibility`, CSS `rotate`/`scale`/`translate` properties** | none (silently ignored) | none |
