---
name: figma-motion-to-lottie
description: Design Figma Motion animations that export to SVG and convert to Lottie/dotLottie with full fidelity using this repo's svg2lottie converter. Use when creating or editing Figma Motion animations meant to ship as Lottie, choosing layer effects/paints/text for Lottie output, or checking an exported animated SVG with the svg2lottie CLI (`--strict`) and `pnpm verify`.
---

# Figma Motion → Lottie (svg2lottie)

The converter (`packages/core`, CLI in `packages/cli`) reads Figma Motion's animated SVG. That SVG uses CSS `@keyframes` for transform, opacity and stroke width, and SMIL `<animate>` for corner radius. The converter writes Lottie JSON or `.lottie`. Anything it cannot represent produces a warning, and a few features are dropped silently (listed below). Design inside the supported set, then prove the result with the two self-checks at the end.

Reference files:
- [references/feature-support.md](references/feature-support.md): full support matrix, warning codes, loop and timeline rules.
- [references/text-and-fonts.md](references/text-and-fonts.md): text and font guidance (outlining is **pending [PR #2](https://github.com/Zurmely/LottieSVG/pull/2)**).
- [references/example-loop.svg](references/example-loop.svg): a small Figma-style export that converts with 0 warnings and passes `pnpm verify`.

## Do

- **Shapes:** Rectangle (uniform corner radius), Ellipse, Line, Polygon/Star, Vector/pen paths, boolean results (flattened to a path), groups, frames.
- **Paints:** solid fills and strokes, fill/stroke opacity, layer opacity, even-odd fill rule, caps/joins/miter, dashed strokes.
- **Gradients:** **linear** gradients, and **circular** radial gradients (drag the two radial handles to equal length).
- **Effects:** **Layer blur** only. It becomes a Lottie Gaussian Blur effect, which lottie-web and dotLottie/ThorVG render but some other players don't.
- **Clipping:** "Clip content" on frames, and plain vector/shape masks that are static and hard-edged. These become `clip-path` in the SVG and a Lottie layer mask.
- **Animate:** position, rotation (any amount, including more than 360°), scale, opacity, fill and stroke colour, stroke width, corner radius, and path morphs between shapes with the **same point count and command structure**.
- **Easing:** any Figma Motion easing, including springs and custom curves. Simple curves export as `cubic-bezier()` and become Lottie bezier handles. Springs are pre-baked into roughly 60 linear keyframes, which are kept one-to-one. Step/hold easing works.
- **Loops:** give every looping layer a duration that divides one master loop (for example 1s, 2s and 4s with a 4s master). Make the last keyframe equal the first.
- **Names:** name layers meaningfully and export with ids. The ids become Lottie layer and group names.
- **Canvas:** keep one top-level frame. Its canvas-sized clip is dropped as a no-op.

## Don't

These are reported as warnings, so `--strict` fails:
- Images or image fills, and pattern fills (`unsupported-image`, `paint-server`).
- Alpha, luminance or soft masks (`mask`). Use hard-edged vector masks instead.
- Drop shadow, inner shadow, background blur and any non-blur filter (`filter`). Fake a shadow with a blurred, offset copy of the shape instead.
- Elliptical radial gradients, which is Figma's default when a radial gradient's handles differ in length (`gradient-transform`). Also avoid focal points (`gradient-focal`) and angular or diamond gradients.
- Animated gradient stops (`gradient-animation`), animated dash patterns (`dasharray-animation`) and animated blur amount (`filter-animation`).
- Path morphs between shapes with different structure (`path-morph`). These snap instead of tweening. Keep point counts equal.
- Different corner radius per corner while animating radius (`rect-radius`). Static mixed corners are fine.
- Motion paths / `animateMotion` (`unsupported-animateMotion`). Animate position keyframes instead.
- Loops whose durations have no common period of 30s or less, such as 4s with 3.7s (`loop-mismatch`).
- Two animations on the same property of one layer (`multiple-animations`). Only the last is kept.
- Interaction or event triggers, such as on click or after another animation (`smil-begin`). Everything starts at 0s.
- Blur or clip on a layer nested inside a plain group that is otherwise flattened into shapes (`nested-layer-feature`).

These are **not** caught by `--strict`, so check them yourself:
- Blend modes other than Normal are dropped silently.
- A start delay on a **looping** layer is only an info note (`loop-delay`). The first cycle's wait is lost, and the layer plays as a phase-shifted loop from frame 0.
- Mixing a one-shot (non-looping) animation with loops. The composition runs until the one-shot ends. A loop whose period doesn't divide that length jumps at the seam, with no warning.
- CSS `offset-path`, animated `visibility`, and the individual `rotate`/`scale`/`translate` CSS properties are ignored silently. Figma Motion doesn't normally emit them. Don't hand-edit them in.
- Blur is an info note (`blur-effect`). It passes `--strict` but isn't rendered by every Lottie player.

## Export settings

- Export the animated frame as **SVG** from Figma Motion, at 1x with the frame's own size. The converter uses the root `viewBox` and `width`/`height`.
- **Include "id" attribute**: on, for readable layer names.
- **Outline text**: on, until [PR #2](https://github.com/Zurmely/LottieSVG/pull/2) lands. Without it, current `main` drops text with `unsupported-text`. See [references/text-and-fonts.md](references/text-and-fonts.md) for what changes after that PR.
- **Simplify stroke**: on, and prefer **Center** stroke alignment. Inside and outside strokes can export as masks or clips.
- Don't post-process the SVG with an optimizer such as SVGO. It can rewrite the transform keyframes into matrices or strip ids.

## Self-check (required before hand-off)

```bash
pnpm install && pnpm build
node packages/cli/dist/cli.js path/to/anim.svg -o out/anim.lottie --strict   # exit 0 = no warnings
node packages/cli/dist/cli.js path/to/anim.svg -o out/anim.json --strict     # same, Lottie JSON
pnpm verify path/to/anim.svg --frames 24                                     # PASS/FAIL per file
```

- `--strict` exits 1 if any **warning** is reported. Read the `info` lines too, because `loop-delay` and `blur-effect` still pass.
- `pnpm verify` renders the SVG in headless Chrome and compares it against lottie-web and the dotLottie player at N frames. It fails when any frame differs by more than `--threshold` (default 1.5% of pixels). Output goes to `verify-output/<name>/`: a report and a contact sheet showing SVG | lottie-web | dotLottie | diffs. Set `CHROME_PATH` if Chrome isn't at `/usr/local/bin/google-chrome`.
- Other useful flags: `--fps <n>` (default 60), `--max-duration <s>` (loop cap, default 30), `--format both`, and a directory input for batch conversion.

## Checklist

- [ ] Only supported shapes, paints and effects are used (the Do list above). No images, masks, shadows or elliptical radial gradients.
- [ ] Every loop duration divides the master loop, and each loop's first and last keyframes are equal.
- [ ] No start delays on looping layers, unless a phase shift from frame 0 is acceptable. Use hold keyframes inside the loop to create a pause.
- [ ] No one-shot animations mixed with loops, unless the loop period divides the total length.
- [ ] Path morphs keep the same point count. Corner-radius animations use a uniform radius.
- [ ] Blend modes are Normal.
- [ ] Text is outlined, or follows [references/text-and-fonts.md](references/text-and-fonts.md).
- [ ] Exported as SVG with ids, simplified strokes and no optimizer.
- [ ] `svg2lottie … --strict` exits 0, and the `info` lines have been reviewed.
- [ ] `pnpm verify …` prints `PASS`.

## Example

[references/example-loop.svg](references/example-loop.svg) is shaped like a real Figma Motion export:
- A rounded card (`#card`) uses a linear gradient. It rotates 180°, pulses its scale and opacity, and morphs its corner radius from 50 to 12 and back.
- A dot (`#dot`) bounces on an overshoot curve.

The card loops every 2s and the dot every 4s, so the Lottie master loop is 4s. The key parts:

```css
#card { transform-origin: 0 0; animation: kf_card_transform_0 2s linear infinite, kf_card_opacity_0 2s linear infinite; }
/* keyframe: translateX(78px) translateY(78px) translate(50px, 50px) rotate(1.571rad) scaleX(1.2) scaleY(1.2) translate(-50px, -50px) */
```

```xml
<animate attributeName="rx" values="50; 12; 50" keyTimes="0; 0.5; 1"
  keySplines="0.65 0 0.35 1; 0.65 0 0.35 1" dur="2s" calcMode="spline" repeatCount="indefinite" />
```

Result: `4s @ 60fps, 0 warnings`, and `pnpm verify` PASS with at most 0.02% of pixels differing in either player.
