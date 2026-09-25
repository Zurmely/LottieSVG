# Text and fonts

> **PENDING [PR #2](https://github.com/Zurmely/LottieSVG/pull/2) (`cursor/text-to-outlines-ff1c`), not yet on `main`.**
> This section describes that branch's code as of commit `7bc343c`: `packages/core/src/text.ts`, `fonts.ts`, `google-fonts.ts`, `resolve-fonts.ts`, `accessibility.ts`, and `packages/cli/src/run.ts`.
> On `main` today, any `<text>` is dropped with warning `unsupported-text`, so **outline text in Figma before exporting** until the PR merges.
> Items marked **[re-verify]** may change before merge.

## How it works

- `<text>`/`<tspan>` are laid out with the real font (fontkit: kerning, ligatures, CSS font matching) and turned into static glyph outlines. **There is no raster fallback.**
- Font sources, in order: faces already loaded, meaning `--fonts <dir>` (repeatable; ttf/otf/woff/woff2/ttc) or an upload in the web UI **[re-verify: web upload UI not yet landed]**. After those, **Google Fonts** is tried for each family in the `font-family` list. It is on by default, `--no-google-fonts` disables it, and downloads are cached in `--font-cache <dir>` (default `~/.cache/svg2lottie/fonts`).
- If no source has the font, you get warning `font-missing` (so `--strict` fails) and that text is skipped. Everything else still converts.
- The original strings are always stored as accessibility metadata: Lottie `meta.d` (the label) and `meta.a11y` (label, source, title, description, every text), plus the dotLottie manifest `description`/`accessibility`. Label priority is `--alt <text>` > root `aria-label` > root `<title>` > all text in document order. Layer names look like `id: Text "…"`.

## Fonts to prefer

- **Google Fonts families** such as Inter, Roboto, Noto Sans, Manrope or DM Sans, so the CLI can fetch them with no setup. For anything else (brand fonts, SF Pro, Helvetica), ship the files and pass `--fonts <dir>`.
- Always name a **concrete** family. Only generic families (`sans-serif`, `system-ui`, …) produce `font-missing`.
- Variable fonts are fine. The `wght` axis is instanced at the requested weight.

## Weights and styles

- Use weights the font actually has. Figma exports `font-weight="bold"` (700) or numeric weights.
- If the face is ≤500 but 600+ was requested, you get warning `font-synthetic-bold` (fails `--strict`), and the outlines come out thinner than the browser's faked bold.
- A missing italic face is slanted like browsers do. This is info `font-synthetic-italic`, so it passes, but providing the real italic face is better.
- Characters missing from every listed family produce warning `glyph-missing` and are skipped. Add a fallback family that covers them, such as Noto.

## Letter-spacing, alignment and layout

- Letter-spacing works in px or em (Figma exports `letter-spacing="-0.02em"`). Any non-zero value disables ligatures, as browsers do. Word-spacing works too.
- Alignment works. Figma bakes it into each line's `tspan x`, and `text-anchor` start/middle/end is honoured per chunk. `dominant-baseline` and `baseline-shift` are supported.
- Fixed/auto-width text boxes are fine, because Figma exports one `tspan` per line. Whitespace follows `xml:space`/`white-space: pre`.
- Animate text as a layer: transform, opacity, and fill/stroke colour all animate.

These produce warnings; avoid them:
- `textPath`: text on a path.
- `textLength`: fixed text width.
- Right-to-left or bidi scripts (`text-direction`, `text-bidi`).
- Vertical `writing-mode` (`text-vertical`).
- Underline or strikethrough (`text-decoration`). Draw a line shape instead.
- `font-variant`.
- Animated `x`/`y`/`font-size`/`letter-spacing` (`text-animation`). Only the first frame is used.
- `transform` on a `tspan` is ignored (`tspan-transform`).

## Live text vs pre-outlined

| Keep live text (Outline text: off) when | Pre-outline in Figma (Outline text: on) when |
|---|---|
| The font is on Google Fonts or you can pass it with `--fonts` | The font can't be obtained or licensed for the build machine |
| You want the text as the accessible label and in layer names automatically | The text uses underline, RTL, vertical text or text-on-path |
| The copy may change and should stay editable | You need to be pixel-identical to Figma's own rasteriser, for example with a synthetic bold |

With pre-outlined text there is no text metadata, so pass `--alt "…"` (or give the SVG a `<title>`) to keep an accessible label.

## Self-check

```bash
node packages/cli/dist/cli.js anim.svg -o out/anim.lottie --strict --fonts ./fonts   # add --no-google-fonts for offline builds
```

- Check the `font: … from Google Fonts` lines to see which families were downloaded.
- Exit 0 means every text was outlined with a real face at the requested weight.

## To re-verify after PR #2 merges

- [ ] Flag names and defaults: `--fonts`, `--no-google-fonts`, `--font-cache`, `--alt`, and that Google Fonts is on by default.
- [ ] Web UI font upload flow and where uploaded fonts rank against Google Fonts.
- [ ] Warning codes and severities: `font-missing`, `glyph-missing`, `font-synthetic-bold` (warning) and `font-synthetic-italic` (info).
- [ ] Metadata fields: `meta.d`, `meta.a11y`, the dotLottie manifest `description`/`accessibility`, and the `@svg2lottie/a11y` helper.
- [ ] `unsupported-text` removed from `main` and from the Don't list in `SKILL.md` and `feature-support.md`. Update the "Outline text: on" export setting.
